import WebSocket from "ws";

export function registerInboundRoutes(fastify) {
  // Check for the required environment variables
  const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID } = process.env;

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
    console.error("Missing required environment variables");
    throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID");
  }

  // Helper function to get signed URL for authenticated conversations
  async function getSignedUrl() {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
        {
          method: 'GET',
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to get signed URL: ${response.statusText}`);
      }

      const data = await response.json();
      return data.signed_url;
    } catch (error) {
      console.error("Error getting signed URL:", error);
      throw error;
    }
  }

  // Route to handle incoming calls from Twilio
  fastify.all("/incoming-call-eleven", async (request, reply) => {
    console.log("[Twilio] Incoming call received");
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/media-stream" mode="bi-directional" />
        </Connect>
      </Response>`;

    reply.type("text/xml").send(twimlResponse);
  });

  // WebSocket route for handling media streams from Twilio
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/media-stream", { websocket: true }, async (connection, req) => {
      console.info("[Server] Twilio connected to media stream.");

      let streamSid = null;
      let elevenLabsWs = null;
      let isClosing = false;

      const closeWithCode = (code, reason) => {
        if (!isClosing) {
          isClosing = true;
          console.log(`[Server] Closing connection with code ${code}: ${reason}`);
          
          // Close ElevenLabs connection if open
          if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.close(1000, "Closing normally");
          }
          
          // Close Twilio connection if open
          if (connection.socket.readyState === WebSocket.OPEN) {
            connection.socket.close(code, reason);
          }
        }
      };

      // Handle messages from Twilio
      connection.socket.on("message", async (rawMessage) => {
        try {
          const data = JSON.parse(rawMessage);
          
          // Validate message format
          if (!data || !data.event) {
            console.error("[Twilio] Invalid message format:", rawMessage.toString());
            closeWithCode(1003, "Invalid message format");
            return;
          }

          switch (data.event) {
            case "start":
              if (!data.start || !data.start.streamSid) {
                console.error("[Twilio] Missing streamSid in start event");
                closeWithCode(1003, "Missing streamSid");
                return;
              }
              streamSid = data.start.streamSid;
              console.log(`[Twilio] Stream started with ID: ${streamSid}`);
              
              try {
                // Get authenticated WebSocket URL
                const signedUrl = await getSignedUrl();
                
                // Connect to ElevenLabs using the signed URL
                elevenLabsWs = new WebSocket(signedUrl);
                
                // Set timeout for connection
                const connectionTimeout = setTimeout(() => {
                  if (elevenLabsWs.readyState !== WebSocket.OPEN) {
                    closeWithCode(1006, "ElevenLabs connection timeout");
                  }
                }, 10000);

                // Handle open event for ElevenLabs WebSocket
                elevenLabsWs.on("open", () => {
                  clearTimeout(connectionTimeout);
                  console.log("[II] Connected to Conversational AI.");
                });

                // Handle messages from ElevenLabs
                elevenLabsWs.on("message", (data) => {
                  if (connection.socket.readyState !== WebSocket.OPEN) {
                    console.error("[II] Cannot send message: Twilio connection closed");
                    return;
                  }
                  
                  try {
                    const message = JSON.parse(data);
                    handleElevenLabsMessage(message, connection.socket);
                  } catch (error) {
                    console.error("[II] Error parsing message:", error);
                  }
                });

                // Handle errors from ElevenLabs WebSocket
                elevenLabsWs.on("error", (error) => {
                  console.error("[II] WebSocket error:", error);
                  closeWithCode(1011, "ElevenLabs WebSocket error");
                });

                // Handle close event for ElevenLabs WebSocket
                elevenLabsWs.on("close", (code, reason) => {
                  console.log(`[II] ElevenLabs disconnected with code ${code}: ${reason}`);
                  closeWithCode(code, reason);
                });

              } catch (error) {
                console.error("[Server] Failed to initialize ElevenLabs connection:", error);
                closeWithCode(1011, "Failed to initialize ElevenLabs connection");
              }
              break;

            case "media":
              if (!elevenLabsWs || elevenLabsWs.readyState !== WebSocket.OPEN) {
                console.error("[Twilio] Cannot process media: ElevenLabs connection not ready");
                return;
              }

              if (!data.media || !data.media.payload) {
                console.error("[Twilio] Invalid media message format");
                return;
              }

              try {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(data.media.payload, "base64").toString("base64")
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              } catch (error) {
                console.error("[Twilio] Error processing media:", error);
              }
              break;

            case "stop":
              closeWithCode(1000, "Stop event received");
              break;

            default:
              console.log(`[Twilio] Received unhandled event: ${data.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
          closeWithCode(1003, "Message processing error");
        }
      });

      // Function to handle messages from ElevenLabs
      const handleElevenLabsMessage = (message, connection) => {
        if (!message || typeof message !== 'object') {
          console.error('[II] Invalid message format received from ElevenLabs');
          return;
        }

        switch (message.type) {
          case "conversation_initiation_metadata":
            console.info("[II] Received conversation initiation metadata.");
            break;
          case "audio":
            if (message.audio_event?.audio_base_64) {
              // Validate streamSid exists
              if (!streamSid) {
                console.error('[II] Cannot send audio: streamSid is not set');
                return;
              }

              try {
                // Ensure the payload is valid base64
                const isBase64 = /^[A-Za-z0-9+/=]+$/.test(message.audio_event.audio_base_64);
                if (!isBase64) {
                  console.error('[II] Invalid base64 payload received from ElevenLabs');
                  return;
                }

                const audioData = {
                  event: "media",
                  streamSid,
                  media: {
                    payload: message.audio_event.audio_base_64,
                  },
                };
                connection.send(JSON.stringify(audioData));
              } catch (error) {
                console.error('[II] Error processing audio message:', error);
              }
            } else {
              console.error('[II] Audio event missing base64 payload');
            }
            break;
          case "interruption":
            connection.send(JSON.stringify({ event: "clear", streamSid }));
            break;
          case "ping":
            if (message.ping_event?.event_id) {
              const pongResponse = {
                type: "pong",
                event_id: message.ping_event.event_id,
              };
              elevenLabsWs.send(JSON.stringify(pongResponse));
            }
            break;
        }
      };

      // Handle close event from Twilio
      connection.socket.on("close", (code, reason) => {
        console.log(`[Twilio] Client disconnected with code ${code}: ${reason}`);
        closeWithCode(code || 1000, reason || "Connection closed");
      });

      // Handle errors from Twilio WebSocket
      connection.socket.on("error", (error) => {
        console.error("[Twilio] WebSocket error:", error);
        closeWithCode(1011, "Twilio WebSocket error");
      });
    });
  });
}
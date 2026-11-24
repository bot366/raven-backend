import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { pool } from "./db.js";
import { transferRoutes } from "./routes/transfers.js";

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });

await app.register(cors, {
  origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",").map((v) => v.trim())
});
await app.register(multipart, {
  limits: { fileSize: config.maxFileSizeBytes, files: 1 }
});

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { status: "ok", service: "RAVEN API", database: "connected" };
});

await app.register(transferRoutes);

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  if (error.statusCode === 413) {
    return reply.code(413).send({ error: "Request or file is too large." });
  }
  return reply.code(500).send({ error: "Internal server error." });
});

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

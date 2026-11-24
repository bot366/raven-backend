import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { pool } from "./db.js";
import { transferRoutes } from "./routes/transfers.js";
import { uploadRoutes } from "./routes/uploads.js";

const app = Fastify({
  logger: true,
  bodyLimit: config.maxFileSizeBytes + 1024 * 1024
});

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
await app.register(uploadRoutes);


app.setErrorHandler((error, request, reply) => {
  request.log.error(error);

  const statusCode =
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;

  if (statusCode === 413) {
    return reply.code(413).send({
      error: "Request or file is too large."
    });
  }

  return reply.code(500).send({
    error: "Internal server error."
  });
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

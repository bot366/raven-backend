import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import {config} from "./config.js";
import {pool} from "./db.js";
import {authRoutes} from "./routes/auth.js";
import {transferRoutes} from "./routes/transfers.js";
const app=Fastify({logger:true,bodyLimit:config.maxFileSizeBytes+1024*1024});
const allowedOrigins=config.corsOrigin.split(",").map(v=>v.trim()).filter(Boolean);
if(!allowedOrigins.length||allowedOrigins.includes("*"))throw new Error("CORS_ORIGIN must contain exact frontend origins; wildcard is not supported.");
await app.register(cors,{origin:allowedOrigins,credentials:true});
await app.register(cookie);
await app.register(multipart,{limits:{fileSize:config.maxFileSizeBytes,files:1}});
app.addHook("onRequest",async(request,reply)=>{
 if(!["POST","PUT","PATCH","DELETE"].includes(request.method))return;
 const origin=request.headers.origin;
 if(origin&&!allowedOrigins.includes(origin))return reply.code(403).send({error:"Request origin is not allowed."});
});
app.get("/health",async()=>{await pool.query("SELECT 1");return {status:"ok",service:"RAVEN API",database:"connected"};});
await app.register(authRoutes);
await app.register(transferRoutes);
app.setErrorHandler((error,request,reply)=>{
 request.log.error(error);
 const code=typeof error==="object"&&error!==null&&"statusCode" in error&&typeof error.statusCode==="number"?error.statusCode:undefined;
 if(code===413)return reply.code(413).send({error:"Request or file is too large."});
 return reply.code(500).send({error:"Internal server error."});
});
const shutdown=async()=>{await app.close();await pool.end();process.exit(0);};
process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
try{await app.listen({port:config.port,host:config.host});}catch(error){app.log.error(error);process.exit(1);}

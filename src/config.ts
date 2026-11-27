import "dotenv/config";
import path from "node:path";
function numberFromEnv(name:string,fallback:number):number{
 const value=Number(process.env[name]??fallback);
 if(!Number.isFinite(value)||value<=0) throw new Error(name+" must be a positive number");
 return value;
}
const b2Values={
 endpoint:process.env.B2_ENDPOINT?.trim()??"",
 region:process.env.B2_REGION?.trim()??"",
 bucket:process.env.B2_BUCKET_NAME?.trim()??"",
 keyId:process.env.B2_KEY_ID?.trim()??"",
 applicationKey:process.env.B2_APPLICATION_KEY?.trim()??""
};
const b2Configured=Object.values(b2Values).every(Boolean);
const b2PartiallyConfigured=Object.values(b2Values).some(Boolean);
if(b2PartiallyConfigured&&!b2Configured) throw new Error("B2 configuration is incomplete. Set B2_ENDPOINT, B2_REGION, B2_BUCKET_NAME, B2_KEY_ID and B2_APPLICATION_KEY together.");
export const config={
 port:numberFromEnv("PORT",3000),host:process.env.HOST??"0.0.0.0",
 databaseUrl:process.env.DATABASE_URL,storageDir:path.resolve(process.env.STORAGE_DIR??"./storage"),
 maxFileSizeBytes:numberFromEnv("MAX_FILE_SIZE_MB",100)*1024*1024,
 expiryHours:numberFromEnv("TRANSFER_EXPIRY_HOURS",24),
 publicBaseUrl:(process.env.PUBLIC_BASE_URL??"http://localhost:3000").replace(/\\/$/,""),
 corsOrigin:process.env.CORS_ORIGIN??"",
 b2:{...b2Values,enabled:b2Configured}
};
if(!config.databaseUrl) throw new Error("DATABASE_URL is missing from environment.");
if(!config.corsOrigin.trim()) throw new Error("CORS_ORIGIN must contain the deployed frontend origin.");

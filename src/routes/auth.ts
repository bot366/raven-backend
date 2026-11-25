import type {FastifyInstance,FastifyReply} from "fastify";
import argon2 from "argon2";
import {randomBytes} from "node:crypto";
import {query} from "../db.js";
import {SESSION_COOKIE_NAME,hashSessionToken,getAuthenticatedUser} from "../auth.js";
const SESSION_SECONDS=7*24*60*60;
type AuthBody={displayName?:unknown;email?:unknown;password?:unknown;};
type UserRow={id:string;display_name:string;email:string;password_hash:string;};
function uniqueViolation(error:unknown):boolean{return typeof error==="object"&&error!==null&&"code" in error&&error.code==="23505";}
function setSessionCookie(reply:FastifyReply,token:string):void{
 reply.setCookie(SESSION_COOKIE_NAME,token,{httpOnly:true,secure:true,sameSite:"none",path:"/",maxAge:SESSION_SECONDS});
}
async function createSession(userId:string,reply:FastifyReply):Promise<void>{
 const token=randomBytes(32).toString("base64url");
 await query("DELETE FROM sessions WHERE expires_at<=NOW()");
 await query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)",[userId,hashSessionToken(token),new Date(Date.now()+SESSION_SECONDS*1000)]);
 setSessionCookie(reply,token);
}
export async function authRoutes(app:FastifyInstance):Promise<void>{
 app.post<{Body:AuthBody}>("/auth/register",async(request,reply)=>{
  const name=typeof request.body?.displayName==="string"?request.body.displayName.trim():"";
  const email=typeof request.body?.email==="string"?request.body.email.trim().toLowerCase():"";
  const password=typeof request.body?.password==="string"?request.body.password:"";
  if(name.length<2||name.length>60)return reply.code(400).send({error:"Name must be between 2 and 60 characters."});
  if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return reply.code(400).send({error:"Enter a valid email address."});
  if(password.length<8||password.length>128)return reply.code(400).send({error:"Password must be between 8 and 128 characters."});
  const hash=await argon2.hash(password,{type:argon2.argon2id});
  let result;
  try{result=await query<{id:string;display_name:string;email:string}>(`INSERT INTO users(display_name,email,password_hash) VALUES($1,$2,$3) RETURNING id,display_name,email`,[name,email,hash]);}
  catch(error){if(uniqueViolation(error))return reply.code(409).send({error:"An account with this email already exists."});throw error;}
  const user=result.rows[0];await createSession(user.id,reply);
  return reply.code(201).send({message:"Account created successfully.",user:{id:user.id,displayName:user.display_name,email:user.email}});
 });
 app.post<{Body:AuthBody}>("/auth/login",async(request,reply)=>{
  const email=typeof request.body?.email==="string"?request.body.email.trim().toLowerCase():"";
  const password=typeof request.body?.password==="string"?request.body.password:"";
  if(!email||!password||password.length>128)return reply.code(400).send({error:"Email and password are required."});
  const result=await query<UserRow>("SELECT id,display_name,email,password_hash FROM users WHERE LOWER(email)=$1 LIMIT 1",[email]);
  const user=result.rows[0];
  const valid=user?await argon2.verify(user.password_hash,password).catch(()=>false):false;
  if(!user||!valid)return reply.code(401).send({error:"Email or password is incorrect."});
  await createSession(user.id,reply);
  return {message:"Login successful.",user:{id:user.id,displayName:user.display_name,email:user.email}};
 });
 app.post("/auth/logout",async(request,reply)=>{
  const token=request.cookies?.[SESSION_COOKIE_NAME];
  if(token)await query("DELETE FROM sessions WHERE token_hash=$1",[hashSessionToken(token)]);
  reply.clearCookie(SESSION_COOKIE_NAME,{path:"/",secure:true,sameSite:"none"});
  return {message:"Logged out successfully."};
 });
 app.get("/auth/me",async(request,reply)=>{
  const user=await getAuthenticatedUser(request.cookies?.[SESSION_COOKIE_NAME]);
  if(!user)return reply.code(401).send({error:"You are not logged in."});
  return {user};
 });
}
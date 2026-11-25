export interface TransferRow {
 id:string; user_id:string|null; recipient_user_id:string|null; filename:string; filesize:string|number; status:string;
 created_at:Date; storage_path:string|null; mime_type:string|null; uploaded_at:Date|null;
 expires_at:Date|null; share_token:string|null; sha256:string|null; chunk_size:number|null; chunk_count:number|null;
}
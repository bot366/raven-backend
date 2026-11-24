export interface TransferRow {
  id: string;
  filename: string;
  filesize: string | number;
  status: string;
  created_at: Date;
  storage_path: string | null;
  mime_type: string | null;
  uploaded_at: Date | null;
  expires_at: Date | null;
  share_token: string | null;
}

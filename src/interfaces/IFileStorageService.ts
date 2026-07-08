export interface IFileStorageService {
  upload(key: string, data: Buffer): Promise<string>;
  download(key: string): Promise<Buffer>;
}

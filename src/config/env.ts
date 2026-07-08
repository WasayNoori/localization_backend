import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  API_KEY: z.string().min(1, "API_KEY is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);

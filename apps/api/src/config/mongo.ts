import mongoose from "mongoose";
import { config } from "./env.js";

let isConnected = false;

export async function connectMongo(): Promise<typeof mongoose> {
  if (isConnected && mongoose.connection.readyState === 1) {
    return mongoose;
  }
  await mongoose.connect(config.MONGODB_URI);
  isConnected = true;
  return mongoose;
}

export async function disconnectMongo(): Promise<void> {
  if (!isConnected) return;
  await mongoose.disconnect();
  isConnected = false;
}

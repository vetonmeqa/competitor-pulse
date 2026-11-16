import { pino } from "pino";

export type Logger = pino.Logger;

export function createLogger(level: string, name: string): Logger {
  return pino({ level, name });
}

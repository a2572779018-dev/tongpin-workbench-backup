import type { PublicUser } from "./types";

declare global {
  namespace Express {
    interface Request {
      currentUser?: PublicUser;
    }
  }
}

export {};

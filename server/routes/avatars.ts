import { Router } from "express";
import { ApiError } from "../errors";
import { JsonStore } from "../store";

const AVATAR_DATA_URL =
  /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export function createAvatarsRouter(store: JsonStore): Router {
  const router = Router();

  router.get("/:userId", async (request, response, next) => {
    try {
      const avatar = await store.read((database) => {
        const user = database.users.find(
          (candidate) => candidate.id === request.params.userId,
        );
        return user?.avatarDataUrl ?? null;
      });
      const match = avatar?.match(AVATAR_DATA_URL);
      if (!match) {
        throw new ApiError(404, "AVATAR_NOT_FOUND", "该账号使用系统默认头像");
      }
      const [, contentType, encoded] = match;
      response.set({
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": contentType,
        "Cross-Origin-Resource-Policy": "cross-origin",
      });
      response.send(Buffer.from(encoded, "base64"));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

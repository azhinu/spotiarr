import { Router, type Router as ExpressRouter } from "express";
import type { EventsController } from "@/presentation/controllers/events.controller";

export const createEventsRouter = (eventsController: EventsController): ExpressRouter => {
  const router: ExpressRouter = Router();

  // Delegate SSE connection handling to the controller
  router.get("/", eventsController.connect);

  return router;
};

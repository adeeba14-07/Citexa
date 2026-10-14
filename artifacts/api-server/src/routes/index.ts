import { Router, type IRouter } from "express";
import healthRouter from "./health";
import storageRouter from "./storage";
import studyGraphRouter from "./studygraph";
import tutorRouter from "./tutor";
import assessmentRouter from "./assessments";
import learningRouter from "./learning";
import exportRouter from "./exports";
import adaptiveRouter from "./adaptive";
import sourceViewRouter from "./sourceview";
import studyToolsRouter from "./studyTools";
import accountRouter from "./account";
import requireAuth from "../middlewares/requireAuth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(storageRouter);
router.use(requireAuth);
router.use(accountRouter);
router.use(studyGraphRouter);
router.use(tutorRouter);
router.use(assessmentRouter);
router.use(learningRouter);
router.use(exportRouter);
router.use(adaptiveRouter);
router.use(studyToolsRouter);
router.use(sourceViewRouter);

export default router;

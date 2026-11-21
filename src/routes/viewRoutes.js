import { Router } from 'express';
import { renderStudio } from '../controllers/viewController.js';

const router = Router();

router.get('/', renderStudio);

export default router;

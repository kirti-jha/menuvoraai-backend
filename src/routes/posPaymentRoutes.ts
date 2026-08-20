import { Router } from 'express';
import { PosPaymentController } from '../controllers/posPaymentController';

const router = Router();

// POS Bridge API Routes
router.post('/payments/pos/initiate', PosPaymentController.initiate);
router.post('/payments/pos/status', PosPaymentController.checkStatus);
router.post('/payments/pos/cancel', PosPaymentController.cancel);
router.all('/payments/pos/callback', PosPaymentController.handleCallback);

// Internal Application Status Polling & Transactions Listing Endpoints
router.get('/payments/pos/transactions', PosPaymentController.listTransactions);
router.get('/payments/pos/callback-logs', PosPaymentController.getCallbackLogs);
router.get('/payments/pos/api-logs', PosPaymentController.getApiLogs);
router.get('/payments/:transactionId/status', PosPaymentController.getInternalStatus);

export default router;

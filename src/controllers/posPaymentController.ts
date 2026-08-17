import { Request, Response } from 'express';
import { EzetapService } from '../services/ezetapService';
import { sql, initializeNeonDatabase } from '../config/neon';

// In-Memory Transaction Fallback Store (when DB connection string isn't provided)
const memoryPosTransactions = new Map<string, any>();
const memoryPosCallbacks = new Set<string>();

export class PosPaymentController {
  
  /**
   * 1. Initiate POS Payment
   * Endpoint: POST /api/payments/pos/initiate
   */
  static async initiate(req: Request, res: Response) {
    try {
      const { 
        amount, 
        externalRefNumber, 
        customerMobileNumber, 
        customerEmail, 
        customerName,
        paymentMode = 'CARD', 
        deviceId = 'DEMO_DEVICE_001' 
      } = req.body;

      if (!amount || parseFloat(amount) <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Valid amount is required for POS initiation.',
          code: 'POS_INVALID_AMOUNT'
        });
      }

      if (!deviceId) {
        return res.status(400).json({
          success: false,
          message: 'Target POS deviceId is required.',
          code: 'POS_DEVICE_ID_REQUIRED'
        });
      }

      // Mandatory Unique externalRefNumber
      const refNumber = externalRefNumber || `ORD_POS_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;
      const transactionId = `TXN_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`;

      // Initial DB record insertion
      if (sql) {
        try {
          await initializeNeonDatabase();
          await sql`
            INSERT INTO pos_transactions (
              transaction_id, order_id, external_ref_number, amount, payment_mode, device_id, status, customer_mobile, customer_email
            ) VALUES (
              ${transactionId}, ${refNumber}, ${refNumber}, ${parseFloat(amount)}, ${paymentMode}, ${deviceId}, 'PENDING', ${customerMobileNumber || ''}, ${customerEmail || ''}
            );
          `;
        } catch (dbErr) {
          console.error('Neon DB insert transaction error:', dbErr);
        }
      }

      // Store in memory fallback
      memoryPosTransactions.set(transactionId, {
        transactionId,
        orderId: refNumber,
        externalRefNumber: refNumber,
        amount: parseFloat(amount),
        paymentMode,
        deviceId,
        status: 'PENDING',
        customerMobileNumber,
        customerEmail,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      memoryPosTransactions.set(refNumber, memoryPosTransactions.get(transactionId));

      // Call Ezetap / Razorpay POS Bridge API
      const ezetapRes = await EzetapService.initiatePayment({
        amount,
        externalRefNumber: refNumber,
        customerMobileNumber,
        customerEmail,
        customerName,
        paymentMode,
        deviceId
      });

      if (!ezetapRes.success && ezetapRes.errorCode) {
        return res.status(400).json({
          success: false,
          message: ezetapRes.errorMessage || 'Unable to initiate POS payment',
          code: ezetapRes.errorCode || 'POS_PAYMENT_INITIATION_FAILED'
        });
      }

      const p2pRequestId = ezetapRes.p2pRequestId || `P2P_${Date.now()}`;

      // Update record with p2pRequestId & initiation response
      if (sql) {
        try {
          await sql`
            UPDATE pos_transactions 
            SET p2p_request_id = ${p2pRequestId}, initiation_response = ${JSON.stringify(ezetapRes)}, updated_at = NOW()
            WHERE transaction_id = ${transactionId} OR external_ref_number = ${refNumber};
          `;
        } catch (dbErr) {
          console.error('Neon DB update p2pRequestId error:', dbErr);
        }
      }

      const record = memoryPosTransactions.get(transactionId);
      if (record) {
        record.p2pRequestId = p2pRequestId;
        record.initiationResponse = ezetapRes;
      }

      return res.status(201).json({
        success: true,
        message: 'Payment request successfully sent to POS device.',
        transactionId,
        p2pRequestId,
        externalRefNumber: refNumber,
        amount: parseFloat(amount),
        paymentMode,
        deviceId,
        status: 'PENDING'
      });

    } catch (err: any) {
      console.error('POS Initiate Error:', err);
      return res.status(500).json({
        success: false,
        message: 'Internal server error while initiating POS payment.',
        code: 'POS_INTERNAL_ERROR'
      });
    }
  }

  /**
   * 2. Check POS Transaction Status from Ezetap
   * Endpoint: POST /api/payments/pos/status
   */
  static async checkStatus(req: Request, res: Response) {
    try {
      const { origP2pRequestId, transactionId, externalRefNumber } = req.body;

      const p2pReqId = origP2pRequestId || req.body.p2pRequestId;

      if (!p2pReqId && !transactionId && !externalRefNumber) {
        return res.status(400).json({
          success: false,
          message: 'origP2pRequestId or transactionId is required.',
          code: 'POS_P2P_ID_REQUIRED'
        });
      }

      // Call Ezetap Status API
      const statusRes = await EzetapService.checkStatus(p2pReqId || 'DEMO_P2P_REQ');

      // Map External Status -> Internal Application Status
      let mappedStatus = 'PENDING';

      if (statusRes.status === 'AUTHORIZED' && statusRes.messageCode === 'P2P_DEVICE_TXN_DONE') {
        mappedStatus = 'SUCCESS';
      } else if (statusRes.status === 'FAILED' && statusRes.messageCode === 'P2P_DEVICE_TXN_DONE') {
        mappedStatus = 'FAILED';
      } else if (statusRes.messageCode === 'P2P_DEVICE_CANCELED' || statusRes.messageCode === 'P2P_STATUS_INIT_CANCELED_FROM_EXTERNAL_SYSTEM') {
        mappedStatus = 'CANCELLED';
      } else if (statusRes.messageCode === 'P2P_DEVICE_RECEIVED' || statusRes.messageCode === 'P2P_STATUS_QUEUED') {
        mappedStatus = 'PENDING';
      } else if (statusRes.status === 'AUTHORIZED') {
        mappedStatus = 'SUCCESS';
      }

      // Update Database
      if (sql && (transactionId || externalRefNumber || p2pReqId)) {
        try {
          await initializeNeonDatabase();
          await sql`
            UPDATE pos_transactions
            SET status = ${mappedStatus}, final_status_response = ${JSON.stringify(statusRes)}, updated_at = NOW()
            WHERE p2p_request_id = ${p2pReqId} OR transaction_id = ${transactionId || ''} OR external_ref_number = ${externalRefNumber || ''};
          `;
        } catch (dbErr) {
          console.error('Neon DB status update error:', dbErr);
        }
      }

      // Update Memory Fallback
      const record = memoryPosTransactions.get(transactionId || externalRefNumber || p2pReqId);
      if (record) {
        record.status = mappedStatus;
        record.finalStatusResponse = statusRes;
        record.updatedAt = new Date().toISOString();
      }

      return res.json({
        success: true,
        transactionId: record?.transactionId || transactionId,
        p2pRequestId: p2pReqId,
        status: mappedStatus,
        rawStatus: statusRes.status,
        messageCode: statusRes.messageCode,
        message: statusRes.message
      });

    } catch (err: any) {
      console.error('POS Check Status Error:', err);
      return res.status(500).json({
        success: false,
        message: 'Unable to query POS payment status.',
        code: 'POS_STATUS_CHECK_FAILED'
      });
    }
  }

  /**
   * 3. Internal Application Transaction Status Polling Endpoint
   * Endpoint: GET /api/payments/:transactionId/status
   */
  static async getInternalStatus(req: Request, res: Response) {
    try {
      const { transactionId } = req.params;

      let record: any = null;

      if (sql) {
        try {
          await initializeNeonDatabase();
          const rows = await sql`
            SELECT transaction_id, order_id, external_ref_number, p2p_request_id, amount, payment_mode, device_id, status, created_at, updated_at
            FROM pos_transactions
            WHERE transaction_id = ${transactionId} OR external_ref_number = ${transactionId} OR p2p_request_id = ${transactionId}
            LIMIT 1;
          `;
          if (rows.length > 0) {
            record = {
              transactionId: rows[0].transaction_id,
              orderId: rows[0].order_id,
              externalRefNumber: rows[0].external_ref_number,
              p2pRequestId: rows[0].p2p_request_id,
              amount: parseFloat(rows[0].amount),
              paymentMode: rows[0].payment_mode,
              deviceId: rows[0].device_id,
              status: rows[0].status,
              createdAt: rows[0].created_at,
              updatedAt: rows[0].updated_at
            };
          }
        } catch (dbErr) {
          console.error('Neon DB fetch transaction error:', dbErr);
        }
      }

      if (!record) {
        record = memoryPosTransactions.get(transactionId);
      }

      if (!record) {
        return res.status(404).json({
          success: false,
          message: `Transaction ${transactionId} not found.`,
          code: 'POS_TRANSACTION_NOT_FOUND'
        });
      }

      return res.json({
        success: true,
        transactionId: record.transactionId,
        orderId: record.orderId,
        p2pRequestId: record.p2pRequestId,
        amount: record.amount,
        paymentMode: record.paymentMode,
        deviceId: record.deviceId,
        status: record.status,
        updatedAt: record.updatedAt
      });

    } catch (err: any) {
      return res.status(500).json({
        success: false,
        message: 'Error fetching transaction status.',
        code: 'POS_FETCH_STATUS_FAILED'
      });
    }
  }

  /**
   * 4. Cancel Active POS Transaction
   * Endpoint: POST /api/payments/pos/cancel
   */
  static async cancel(req: Request, res: Response) {
    try {
      const { origP2pRequestId, deviceId, transactionId } = req.body;

      const p2pReqId = origP2pRequestId || req.body.p2pRequestId;

      if (!p2pReqId && !transactionId) {
        return res.status(400).json({
          success: false,
          message: 'p2pRequestId or transactionId is required for cancellation.',
          code: 'POS_CANCEL_PARAM_MISSING'
        });
      }

      const cancelRes = await EzetapService.cancelPayment(p2pReqId || 'DEMO_P2P', deviceId || 'DEMO_DEVICE');

      // Update Database
      if (sql) {
        try {
          await initializeNeonDatabase();
          await sql`
            UPDATE pos_transactions
            SET status = 'CANCELLED', final_status_response = ${JSON.stringify(cancelRes)}, updated_at = NOW()
            WHERE p2p_request_id = ${p2pReqId} OR transaction_id = ${transactionId || ''};
          `;
        } catch (dbErr) {
          console.error('Neon DB cancel update error:', dbErr);
        }
      }

      const record = memoryPosTransactions.get(transactionId || p2pReqId);
      if (record) {
        record.status = 'CANCELLED';
        record.updatedAt = new Date().toISOString();
      }

      return res.json({
        success: true,
        message: 'POS transaction cancellation requested successfully.',
        p2pRequestId: p2pReqId,
        status: 'CANCELLED'
      });

    } catch (err: any) {
      console.error('POS Cancel Error:', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to cancel POS transaction.',
        code: 'POS_CANCEL_FAILED'
      });
    }
  }

  /**
   * 5. Server-to-Server Callback Webhook Handler (IDEMPOTENT)
   * Endpoint: POST /api/payments/pos/callback
   */
  static async handleCallback(req: Request, res: Response) {
    try {
      const callbackPayload = req.body;
      const { p2pRequestId, origP2pRequestId, externalRefNumber, status, messageCode } = callbackPayload;

      const targetP2pReqId = p2pRequestId || origP2pRequestId || callbackPayload.data?.p2pRequestId;
      const refNumber = externalRefNumber || callbackPayload.data?.externalRefNumber;

      const key = `${targetP2pReqId}_${refNumber}_${status}`;

      // Idempotency Check: Don't re-process exact duplicate callback
      if (memoryPosCallbacks.has(key)) {
        console.log(`ℹ️ [POS Callback] Duplicate callback received for key: ${key}. Acknowledging HTTP 200.`);
        return res.status(200).json({
          success: true,
          message: 'Callback already processed (Idempotent).'
        });
      }

      memoryPosCallbacks.add(key);

      // Audit Log into Database
      if (sql) {
        try {
          await initializeNeonDatabase();
          
          // Check if already in DB
          const existing = await sql`
            SELECT id FROM pos_callbacks 
            WHERE p2p_request_id = ${targetP2pReqId || ''} AND external_ref_number = ${refNumber || ''} 
            LIMIT 1;
          `;

          if (existing.length === 0) {
            await sql`
              INSERT INTO pos_callbacks (p2p_request_id, external_ref_number, status, payload)
              VALUES (${targetP2pReqId || ''}, ${refNumber || ''}, ${status || 'COMPLETED'}, ${JSON.stringify(callbackPayload)});
            `;
          }
        } catch (dbErr) {
          console.error('Neon DB callback audit error:', dbErr);
        }
      }

      // Determine mapped status
      let finalStatus = 'SUCCESS';
      if (status === 'AUTHORIZED' || messageCode === 'P2P_DEVICE_TXN_DONE') {
        finalStatus = 'SUCCESS';
      } else if (status === 'FAILED') {
        finalStatus = 'FAILED';
      } else if (status === 'CANCELLED' || messageCode === 'P2P_DEVICE_CANCELED') {
        finalStatus = 'CANCELLED';
      }

      // Update Transaction Record in DB
      if (sql && (targetP2pReqId || refNumber)) {
        try {
          await sql`
            UPDATE pos_transactions
            SET status = ${finalStatus}, final_status_response = ${JSON.stringify(callbackPayload)}, updated_at = NOW()
            WHERE p2p_request_id = ${targetP2pReqId || ''} OR external_ref_number = ${refNumber || ''};
          `;
        } catch (dbErr) {
          console.error('Neon DB callback transaction update error:', dbErr);
        }
      }

      const record = memoryPosTransactions.get(targetP2pReqId) || memoryPosTransactions.get(refNumber);
      if (record) {
        record.status = finalStatus;
        record.updatedAt = new Date().toISOString();
      }

      console.log(`✅ [POS Callback] Processed callback for ${refNumber} -> Status: ${finalStatus}`);

      // Always return HTTP 200 to acknowledge Ezetap server-to-server webhook
      return res.status(200).json({
        success: true,
        message: 'POS callback received and acknowledged successfully.'
      });

    } catch (err: any) {
      console.error('POS Callback Handler Error:', err);
      // Return HTTP 500 so third-party system can retry up to 3 times as specified in documentation
      return res.status(500).json({
        success: false,
        message: 'Internal error processing callback.'
      });
    }
  }
}

import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { EzetapService } from '../services/ezetapService';
import { sql, initializeNeonDatabase } from '../config/neon';

/**
 * Format a Date or Date String into Indian Standard Time (IST)
 * Format e.g.: "20/08/2026, 10:58:17 am IST"
 */
export function getISTTimestamp(dateInput?: Date | string | null): string {
  const date = dateInput ? new Date(dateInput) : new Date();
  if (isNaN(date.getTime())) return new Date().toISOString() + ' IST';
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }) + ' IST';
}

/**
 * Format Date into IST ISO-style string e.g. "2026-08-20T10:58:17+05:30"
 */
export function getISTISOString(dateInput?: Date | string | null): string {
  const date = dateInput ? new Date(dateInput) : new Date();
  if (isNaN(date.getTime())) return new Date().toISOString();
  // IST is UTC + 5:30 (+330 minutes)
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const istDate = new Date(utc + (330 * 60000));
  
  const pad = (n: number) => n.toString().padStart(2, '0');
  const year = istDate.getFullYear();
  const month = pad(istDate.getMonth() + 1);
  const day = pad(istDate.getDate());
  const hours = pad(istDate.getHours());
  const minutes = pad(istDate.getMinutes());
  const seconds = pad(istDate.getSeconds());
  
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+05:30`;
}

// Helper function to log EVERY incoming callback request to disk file: logs/pos_callbacks.log
function writeCallbackLog(req: Request) {
  try {
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFilePath = path.join(logDir, 'pos_callbacks.log');
    const timestamp = `${getISTTimestamp()} (${getISTISOString()})`;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'UNKNOWN';

    const logEntry = `--------------------------------------------------------------------------------
[CALLBACK RECEIVED IST] ${timestamp}
Method: ${req.method}
URL: ${req.originalUrl || req.url}
Client IP: ${clientIp}
Content-Type: ${req.headers['content-type'] || 'N/A'}
Headers: ${JSON.stringify(req.headers, null, 2)}
Query Params: ${JSON.stringify(req.query, null, 2)}
Body: ${JSON.stringify(req.body, null, 2)}
--------------------------------------------------------------------------------\n\n`;

    fs.appendFileSync(logFilePath, logEntry, 'utf-8');
    console.log(`📝 [Callback File Logger] Appended incoming callback to ${logFilePath}`);
  } catch (err) {
    console.error('❌ [Callback File Logger Error]:', err);
  }
}

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
        createdAt: getISTISOString(),
        updatedAt: getISTISOString()
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
   * 5. Server-to-Server Callback Webhook Handler (IDEMPOTENT & UPSERT READY)
   * Endpoint: POST / GET /api/payments/pos/callback
   */
  static async handleCallback(req: Request, res: Response) {
    // 0. Log EVERY incoming request immediately to file (logs/pos_callbacks.log)
    writeCallbackLog(req);

    try {
      // Merge body & query parameters to support GET and POST (JSON, urlencoded, query string)
      const rawPayload = { ...req.query, ...req.body };
      const nestedData = rawPayload.data || rawPayload.response || rawPayload.payload || rawPayload.txnReport || {};
      const callbackPayload = { ...rawPayload, ...nestedData };

      // Flexible extraction of IDs and Fields from Ezetap / Razorpay POS callback payloads
      const targetP2pReqId = callbackPayload.p2pRequestId || 
                             callbackPayload.origP2pRequestId || 
                             callbackPayload.p2p_request_id || 
                             callbackPayload.requestId || 
                             callbackPayload.txnId || 
                             '';

      const refNumber = callbackPayload.externalRefNumber || 
                        callbackPayload.external_ref_number || 
                        callbackPayload.orderId || 
                        callbackPayload.order_id || 
                        callbackPayload.refNumber || 
                        `ORD_POS_${Date.now()}`;

      const rawStatus = (callbackPayload.status || callbackPayload.txnStatus || callbackPayload.messageCode || callbackPayload.responseCode || '').toString().toUpperCase();
      const amountVal = callbackPayload.amount || callbackPayload.txnAmount || callbackPayload.totalAmount || 0;
      const paymentModeVal = (callbackPayload.paymentMode || callbackPayload.payment_mode || callbackPayload.mode || 'CARD').toString().toUpperCase();
      const deviceIdVal = callbackPayload.deviceId || callbackPayload.device_id || callbackPayload.pushTo?.deviceId || 'POS_DEVICE';
      const customerMobileVal = callbackPayload.customerMobileNumber || callbackPayload.customer_mobile || callbackPayload.customerMobile || '';
      const customerEmailVal = callbackPayload.customerEmail || callbackPayload.customer_email || callbackPayload.email || '';

      const key = `${targetP2pReqId}_${refNumber}_${rawStatus}`;

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
          await sql`
            INSERT INTO pos_callbacks (p2p_request_id, external_ref_number, status, payload)
            VALUES (${targetP2pReqId}, ${refNumber}, ${rawStatus || 'COMPLETED'}, ${JSON.stringify(callbackPayload)});
          `;
        } catch (dbErr) {
          console.error('Neon DB callback audit error:', dbErr);
        }
      }

      // Determine mapped status
      let finalStatus = 'SUCCESS';
      if (
        rawStatus.includes('AUTHORIZED') || 
        rawStatus.includes('SUCCESS') || 
        rawStatus.includes('COMPLETED') || 
        rawStatus.includes('DONE') || 
        rawStatus.includes('0000') || 
        rawStatus.includes('PAID') || 
        rawStatus.includes('CAPTURED')
      ) {
        finalStatus = 'SUCCESS';
      } else if (
        rawStatus.includes('FAIL') || 
        rawStatus.includes('DECLINED') || 
        rawStatus.includes('ERROR') || 
        rawStatus.includes('REJECTED')
      ) {
        finalStatus = 'FAILED';
      } else if (
        rawStatus.includes('CANCEL')
      ) {
        finalStatus = 'CANCELLED';
      }

      // UPSERT Transaction in DB
      let transactionId = `TXN_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`;

      if (sql) {
        try {
          await initializeNeonDatabase();
          // First attempt UPDATE
          const updateRes = await sql`
            UPDATE pos_transactions
            SET 
              status = ${finalStatus}, 
              p2p_request_id = CASE WHEN ${targetP2pReqId} != '' THEN ${targetP2pReqId} ELSE p2p_request_id END,
              final_status_response = ${JSON.stringify(callbackPayload)}, 
              updated_at = NOW()
            WHERE (p2p_request_id IS NOT NULL AND p2p_request_id != '' AND p2p_request_id = ${targetP2pReqId}) 
               OR external_ref_number = ${refNumber}
            RETURNING transaction_id;
          `;

          if (updateRes.length > 0) {
            transactionId = updateRes[0].transaction_id;
          } else {
            // Transaction was NOT found in DB, perform INSERT (UPSERT)
            await sql`
              INSERT INTO pos_transactions (
                transaction_id, order_id, external_ref_number, p2p_request_id, amount, payment_mode, device_id, status, customer_mobile, customer_email, final_status_response
              ) VALUES (
                ${transactionId}, ${refNumber}, ${refNumber}, ${targetP2pReqId}, ${parseFloat(amountVal) || 0}, ${paymentModeVal}, ${deviceIdVal}, ${finalStatus}, ${customerMobileVal}, ${customerEmailVal}, ${JSON.stringify(callbackPayload)}
              );
            `;
            console.log(`✨ [POS Callback] New transaction record created from callback: ${refNumber} (Status: ${finalStatus})`);
          }
        } catch (dbErr) {
          console.error('Neon DB callback transaction upsert error:', dbErr);
        }
      }

      // Update / Insert into Memory Fallback Store
      const existingMemRecord = memoryPosTransactions.get(targetP2pReqId) || memoryPosTransactions.get(refNumber);
      if (existingMemRecord) {
        existingMemRecord.status = finalStatus;
        if (targetP2pReqId) existingMemRecord.p2pRequestId = targetP2pReqId;
        existingMemRecord.finalStatusResponse = callbackPayload;
        existingMemRecord.updatedAt = getISTISOString();
        memoryPosTransactions.set(existingMemRecord.transactionId, existingMemRecord);
        memoryPosTransactions.set(refNumber, existingMemRecord);
      } else {
        const newMemRecord = {
          transactionId,
          orderId: refNumber,
          externalRefNumber: refNumber,
          p2pRequestId: targetP2pReqId,
          amount: parseFloat(amountVal) || 0,
          paymentMode: paymentModeVal,
          deviceId: deviceIdVal,
          status: finalStatus,
          customerMobileNumber: customerMobileVal,
          customerEmail: customerEmailVal,
          finalStatusResponse: callbackPayload,
          createdAt: getISTISOString(),
          updatedAt: getISTISOString()
        };
        memoryPosTransactions.set(transactionId, newMemRecord);
        memoryPosTransactions.set(refNumber, newMemRecord);
        if (targetP2pReqId) memoryPosTransactions.set(targetP2pReqId, newMemRecord);
      }

      console.log(`✅ [POS Callback] Processed callback for ${refNumber} -> Final Status: ${finalStatus}`);

      // Always return HTTP 200 to acknowledge Ezetap server-to-server webhook
      return res.status(200).json({
        success: true,
        message: 'POS callback received and acknowledged successfully.',
        externalRefNumber: refNumber,
        status: finalStatus
      });

    } catch (err: any) {
      console.error('POS Callback Handler Error:', err);
      return res.status(500).json({
        success: false,
        message: 'Internal error processing callback.'
      });
    }
  }

  /**
   * Fetch All POS Transactions (For Merchant Dashboard & History)
   * Endpoint: GET /api/payments/pos/transactions
   */
  static async listTransactions(req: Request, res: Response) {
    try {
      let transactions: any[] = [];
      // Query Neon PostgreSQL DB
      if (sql) {
        try {
          await initializeNeonDatabase();
          const rows = await sql`
            SELECT 
              transaction_id AS "transactionId",
              external_ref_number AS "externalRefNumber",
              customer_email AS "customerEmail",
              customer_mobile AS "customerMobileNumber",
              amount,
              payment_mode AS "paymentMode",
              device_id AS "deviceId",
              status,
              created_at AS "timestamp"
            FROM pos_transactions
            ORDER BY id DESC;
          `;
          transactions = rows;
        } catch (dbErr) {
          console.error('Neon DB fetch pos_transactions error:', dbErr);
        }
      }
      // Fallback to in-memory transactions if DB query returns empty
      if (transactions.length === 0) {
        const uniqueMemTxns = new Map<string, any>();
        for (const item of memoryPosTransactions.values()) {
          if (item && item.transactionId) {
            uniqueMemTxns.set(item.transactionId, item);
          }
        }
        transactions = Array.from(uniqueMemTxns.values());
      }

      // Format all timestamps into Indian Standard Time (IST)
      const formattedTransactions = transactions.map((item: any) => {
        const rawTime = item.timestamp || item.createdAt || item.created_at;
        return {
          ...item,
          timestamp: getISTISOString(rawTime),
          formattedTimeIST: getISTTimestamp(rawTime)
        };
      });

      return res.json({
        success: true,
        count: formattedTransactions.length,
        data: formattedTransactions
      });
    } catch (err: any) {
      console.error('Fetch POS Transactions Error:', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch POS transactions history.',
        code: 'POS_FETCH_ALL_FAILED'
      });
    }
  }

  // Alias for backward compatibility
  static async getAllTransactions(req: Request, res: Response) {
    return PosPaymentController.listTransactions(req, res);
  }

  /**
   * View Callback Raw Logs Endpoint
   * Endpoint: GET /api/payments/pos/callback-logs
   */
  static async getCallbackLogs(req: Request, res: Response) {
    try {
      const logFilePath = path.join(process.cwd(), 'logs', 'pos_callbacks.log');
      if (!fs.existsSync(logFilePath)) {
        return res.json({
          success: true,
          message: 'No callback logs recorded yet.',
          logs: ''
        });
      }
      const logs = fs.readFileSync(logFilePath, 'utf-8');
      return res.type('text/plain').send(logs);
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to read callback log file.'
      });
    }
  }
}

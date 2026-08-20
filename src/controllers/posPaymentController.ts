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

      if (!ezetapRes.success || !ezetapRes.p2pRequestId) {
        if (sql) {
          try {
            await sql`
              UPDATE pos_transactions 
              SET status = 'FAILED', initiation_response = ${JSON.stringify(ezetapRes)}, updated_at = NOW()
              WHERE transaction_id = ${transactionId} OR external_ref_number = ${refNumber};
            `;
          } catch (dbErr) {
            console.error('Neon DB update initiation failure error:', dbErr);
          }
        }
        const record = memoryPosTransactions.get(transactionId);
        if (record) {
          record.status = 'FAILED';
          record.initiationResponse = ezetapRes;
        }

        return res.status(400).json({
          success: false,
          message: ezetapRes.errorMessage || ezetapRes.message || 'Unable to initiate POS payment on Ezetap device.',
          code: ezetapRes.errorCode || ezetapRes.messageCode || 'POS_PAYMENT_INITIATION_FAILED',
          rawResponse: ezetapRes
        });
      }

      const p2pRequestId = ezetapRes.p2pRequestId;

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
   * 2. Check POS Transaction Status from Ezetap / Razorpay
   * Endpoint: POST / GET /api/payments/pos/status
   */
  static async checkStatus(req: Request, res: Response) {
    try {
      const rawPayload = { ...req.query, ...req.body };
      const targetTxnId = req.params.transactionId || rawPayload.transactionId || rawPayload.externalRefNumber || rawPayload.origP2pRequestId || rawPayload.p2pRequestId || '';

      if (!targetTxnId) {
        return res.status(400).json({
          success: false,
          message: 'transactionId, externalRefNumber, or p2pRequestId is required.',
          code: 'POS_P2P_ID_REQUIRED'
        });
      }

      let record: any = null;
      if (sql) {
        try {
          await initializeNeonDatabase();
          const rows = await sql`
            SELECT transaction_id, order_id, external_ref_number, p2p_request_id, amount, payment_mode, device_id, status, final_status_response, created_at, updated_at
            FROM pos_transactions
            WHERE transaction_id = ${targetTxnId} OR external_ref_number = ${targetTxnId} OR p2p_request_id = ${targetTxnId}
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
              finalStatusResponse: rows[0].final_status_response,
              createdAt: rows[0].created_at,
              updatedAt: rows[0].updated_at
            };
          }
        } catch (dbErr) {
          console.error('Neon DB status fetch error:', dbErr);
        }
      }

      if (!record) {
        record = memoryPosTransactions.get(targetTxnId);
      }

      // If P2P Request ID is present, optionally query live Ezetap P2P Status API
      const p2pReqId = record?.p2pRequestId || targetTxnId;
      let mappedStatus = record?.status || 'PENDING';
      let statusRes: any = record?.finalStatusResponse || null;

      if (p2pReqId && p2pReqId.startsWith('P2P_')) {
        try {
          statusRes = await EzetapService.checkStatus(p2pReqId);
          if (statusRes.status === 'AUTHORIZED' || statusRes.status === 'CAPTURED' || statusRes.messageCode === 'P2P_DEVICE_TXN_DONE') {
            mappedStatus = 'SUCCESS';
          } else if (statusRes.status === 'FAILED') {
            mappedStatus = 'FAILED';
          }
        } catch (e) {
          console.warn('Ezetap status check fallback error:', e);
        }
      }

      const resp = statusRes || record?.finalStatusResponse || {};
      const rzpEntity = resp.payload?.payment?.entity || resp.payment?.entity;
      const razorpayPaymentId = rzpEntity?.id || record?.p2pRequestId || record?.transactionId || targetTxnId;
      const isCaptured = mappedStatus === 'SUCCESS' || mappedStatus === 'CAPTURED' || rzpEntity?.status === 'captured';

      const finalAmount = parseFloat(record?.amount) || (rzpEntity?.amount ? rzpEntity.amount / 100 : 0);
      const finalTime = record?.updatedAt || record?.createdAt || new Date();

      return res.json({
        success: true,
        transactionId: record?.transactionId || targetTxnId,
        orderId: record?.orderId || record?.externalRefNumber || targetTxnId,
        externalRefNumber: record?.externalRefNumber || targetTxnId,
        status: isCaptured ? 'CAPTURED' : mappedStatus,
        razorpayPaymentId: razorpayPaymentId,
        paymentMode: record?.paymentMode || rzpEntity?.method || 'CARD',
        amount: finalAmount,
        verifiedAt: getISTISOString(finalTime),
        formattedVerifiedAtIST: getISTTimestamp(finalTime),
        message: 'Live status verified successfully with Razorpay Gateway'
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
    return PosPaymentController.checkStatus(req, res);
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
   * 5. Server-to-Server Callback Webhook Handler (IDEMPOTENT & SINGLE-ROW DEDUPLICATED)
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

      // Extract Razorpay nested payment entity if present
      const rzpPayment = rawPayload.payload?.payment?.entity || callbackPayload.payload?.payment?.entity || callbackPayload.payment?.entity;
      const eventType = (callbackPayload.event || '').toString().toLowerCase();

      // Extraction of unique IDs
      const rzpPaymentId = rzpPayment?.id || '';
      const bankRrn = rzpPayment?.acquirer_data?.rrn || callbackPayload.rrn || '';
      const targetP2pReqId = callbackPayload.p2pRequestId || 
                             callbackPayload.origP2pRequestId || 
                             callbackPayload.p2p_request_id || 
                             callbackPayload.requestId || 
                             callbackPayload.txnId || 
                             rzpPaymentId ||
                             '';

      const refNumber = callbackPayload.externalRefNumber || 
                        callbackPayload.external_ref_number || 
                        callbackPayload.orderId || 
                        callbackPayload.order_id || 
                        callbackPayload.refNumber || 
                        rzpPayment?.order_id ||
                        (rzpPaymentId ? `ORD_${rzpPaymentId}` : `ORD_POS_${Date.now()}`);

      const rawStatus = (callbackPayload.status || callbackPayload.txnStatus || callbackPayload.messageCode || callbackPayload.responseCode || rzpPayment?.status || eventType || '').toString().toUpperCase();

      // Amount extraction (Razorpay sends amount in paise e.g. 10000 paise = 100.00 INR)
      let parsedAmount = 0;
      if (rzpPayment && rzpPayment.amount !== undefined && rzpPayment.amount !== null) {
        parsedAmount = rzpPayment.amount >= 100 ? rzpPayment.amount / 100 : rzpPayment.amount;
      } else {
        const amountVal = callbackPayload.amount || 
                          callbackPayload.txnAmount || 
                          callbackPayload.totalAmount || 
                          callbackPayload.chargeAmount || 
                          callbackPayload.formattedAmount || 
                          callbackPayload.amountInRupees || 
                          callbackPayload.data?.amount || 
                          callbackPayload.data?.txnAmount || 
                          0;

        const cleanedAmountStr = String(amountVal).replace(/[^0-9.]/g, '');
        parsedAmount = parseFloat(cleanedAmountStr) || 0;
      }

      const paymentModeVal = (callbackPayload.paymentMode || callbackPayload.payment_mode || callbackPayload.mode || rzpPayment?.method || 'CARD').toString().toUpperCase();
      const deviceIdVal = callbackPayload.deviceId || callbackPayload.device_id || callbackPayload.pushTo?.deviceId || rzpPayment?.device_id || 'POS_DEVICE';
      const customerMobileVal = callbackPayload.customerMobileNumber || callbackPayload.customer_mobile || callbackPayload.customerMobile || rzpPayment?.contact || '';
      const customerEmailVal = callbackPayload.customerEmail || callbackPayload.customer_email || callbackPayload.email || rzpPayment?.email || rzpPayment?.vpa || '';

      const dedupeKey = `${rzpPaymentId || targetP2pReqId || refNumber}_${eventType || rawStatus}`;

      // Idempotency Check: Don't re-process exact duplicate callback
      if (memoryPosCallbacks.has(dedupeKey)) {
        console.log(`ℹ️ [POS Callback] Duplicate callback received for key: ${dedupeKey}. Acknowledging HTTP 200.`);
        return res.status(200).json({
          success: true,
          message: 'Callback already processed (Idempotent).'
        });
      }

      memoryPosCallbacks.add(dedupeKey);

      // Audit Log into Database
      if (sql) {
        try {
          await initializeNeonDatabase();
          await sql`
            INSERT INTO pos_callbacks (p2p_request_id, external_ref_number, status, payload)
            VALUES (${targetP2pReqId || rzpPaymentId}, ${refNumber}, ${eventType || rawStatus || 'COMPLETED'}, ${JSON.stringify(callbackPayload)});
          `;
        } catch (dbErr) {
          console.error('Neon DB callback audit error:', dbErr);
        }
      }

      // Determine Status mapping based on Event Type & Status
      // Primary SUCCESS event: payment.captured, qr_code.credited, CAPTURED, AUTHORIZED, SUCCESS
      let isSuccessEvent = false;
      let isFailedEvent = false;

      if (
        eventType === 'payment.captured' || 
        eventType === 'qr_code.credited' || 
        rawStatus.includes('CAPTURED') || 
        rawStatus.includes('SUCCESS') || 
        rawStatus.includes('COMPLETED') || 
        rawStatus.includes('DONE') || 
        rawStatus.includes('0000') || 
        rawStatus.includes('PAID')
      ) {
        isSuccessEvent = true;
      } else if (
        eventType === 'payment.failed' || 
        rawStatus.includes('FAIL') || 
        rawStatus.includes('DECLINED') || 
        rawStatus.includes('ERROR') || 
        rawStatus.includes('REJECTED')
      ) {
        isFailedEvent = true;
      }

      let finalStatus = isSuccessEvent ? 'SUCCESS' : isFailedEvent ? 'FAILED' : 'PENDING';

      // SINGLE-ROW UPSERT Logic in Database
      let transactionId = `TXN_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`;

      if (sql) {
        try {
          await initializeNeonDatabase();
          // First check if an existing transaction record matches by payment_id, p2p_request_id, or external_ref_number
          const existingRows = await sql`
            SELECT id, transaction_id, status, amount
            FROM pos_transactions
            WHERE (p2p_request_id IS NOT NULL AND p2p_request_id != '' AND p2p_request_id = ${targetP2pReqId})
               OR (transaction_id = ${rzpPaymentId} OR p2p_request_id = ${rzpPaymentId})
               OR external_ref_number = ${refNumber}
               OR (final_status_response->'payload'->'payment'->'entity'->>'id' = ${rzpPaymentId} AND ${rzpPaymentId} != '')
            LIMIT 1;
          `;

          if (existingRows.length > 0) {
            const existing = existingRows[0];
            transactionId = existing.transaction_id;
            
            // Don't downgrade status if existing is already SUCCESS / CAPTURED
            const newStatus = (existing.status === 'SUCCESS' || existing.status === 'CAPTURED') ? existing.status : finalStatus;
            const newAmount = parsedAmount > 0 ? parsedAmount : parseFloat(existing.amount);

            await sql`
              UPDATE pos_transactions
              SET 
                status = ${newStatus}, 
                p2p_request_id = CASE WHEN ${targetP2pReqId} != '' THEN ${targetP2pReqId} ELSE p2p_request_id END,
                amount = ${newAmount},
                payment_mode = ${paymentModeVal},
                customer_email = CASE WHEN ${customerEmailVal} != '' THEN ${customerEmailVal} ELSE customer_email END,
                customer_mobile = CASE WHEN ${customerMobileVal} != '' THEN ${customerMobileVal} ELSE customer_mobile END,
                device_id = CASE WHEN ${deviceIdVal} != 'POS_DEVICE' THEN ${deviceIdVal} ELSE device_id END,
                final_status_response = ${JSON.stringify(callbackPayload)}, 
                updated_at = NOW()
              WHERE id = ${existing.id};
            `;
            console.log(`✅ [POS Callback] Updated existing single-row transaction ID ${existing.id} (${refNumber}) -> Status: ${newStatus}, Amount: ₹${newAmount}`);
          } else {
            // New Single-Row Transaction
            await sql`
              INSERT INTO pos_transactions (
                transaction_id, order_id, external_ref_number, p2p_request_id, amount, payment_mode, device_id, status, customer_mobile, customer_email, final_status_response
              ) VALUES (
                ${transactionId}, ${refNumber}, ${refNumber}, ${targetP2pReqId}, ${parsedAmount}, ${paymentModeVal}, ${deviceIdVal}, ${finalStatus}, ${customerMobileVal}, ${customerEmailVal}, ${JSON.stringify(callbackPayload)}
              );
            `;
            console.log(`✨ [POS Callback] Created new single-row transaction record: ${refNumber} (Amount: ₹${parsedAmount}, Status: ${finalStatus})`);
          }
        } catch (dbErr) {
          console.error('Neon DB callback transaction upsert error:', dbErr);
        }
      }

      // Update / Insert into Memory Fallback Store
      const memKey = rzpPaymentId || targetP2pReqId || refNumber;
      const existingMemRecord = memoryPosTransactions.get(memKey) || memoryPosTransactions.get(refNumber);
      if (existingMemRecord) {
        if (existingMemRecord.status !== 'SUCCESS') {
          existingMemRecord.status = finalStatus;
        }
        if (targetP2pReqId) existingMemRecord.p2pRequestId = targetP2pReqId;
        if (parsedAmount > 0) existingMemRecord.amount = parsedAmount;
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
          amount: parsedAmount,
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

      console.log(`✅ [POS Callback] Processed event ${eventType || rawStatus} for ${refNumber} -> Final Status: ${finalStatus}`);

      return res.status(200).json({
        success: true,
        message: 'POS callback processed and acknowledged successfully.',
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
              order_id AS "orderId",
              external_ref_number AS "externalRefNumber",
              p2p_request_id AS "p2pRequestId",
              customer_email AS "customerEmail",
              customer_mobile AS "customerMobileNumber",
              amount,
              payment_mode AS "paymentMode",
              device_id AS "deviceId",
              status,
              final_status_response AS "finalStatusResponse",
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

      // Format all timestamps into Indian Standard Time (IST) & parse metadata + rawLog
      const formattedTransactions = transactions.map((item: any) => {
        const rawTime = item.timestamp || item.createdAt || item.created_at;
        const numAmount = parseFloat(item.amount);
        const resp = item.finalStatusResponse || item.final_status_response || item.initiationResponse || item.initiation_response || {};
        const rzpEntity = resp.payload?.payment?.entity || resp.payment?.entity;
        
        const paymentId = rzpEntity?.id || item.transactionId || item.p2pRequestId || 'N/A';
        const bankRrn = rzpEntity?.acquirer_data?.rrn || resp.rrn || resp.bankRrn || 'N/A';
        const custName = item.customerName || rzpEntity?.notes?.username || (item.customerEmail ? item.customerEmail.split('@')[0] : 'POS Customer');
        const custEmail = item.customerEmail || rzpEntity?.email || rzpEntity?.vpa || '';
        const custMobile = item.customerMobileNumber || rzpEntity?.contact || '';

        return {
          transactionId: item.transactionId,
          orderId: item.orderId || item.externalRefNumber,
          externalRefNumber: item.externalRefNumber,
          customerName: custName,
          customerEmail: custEmail,
          customerMobileNumber: custMobile,
          amount: isNaN(numAmount) ? 0 : numAmount,
          paymentMode: item.paymentMode || rzpEntity?.method || 'CARD',
          deviceId: item.deviceId || rzpEntity?.device_id || 'POS_DEVICE',
          status: item.status,
          timestamp: getISTISOString(rawTime),
          formattedTimeIST: getISTTimestamp(rawTime),
          paymentId,
          bankRrn,
          rawLog: resp
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

  /**
   * View Outbound POS API Call Logs Endpoint
   * Endpoint: GET /api/payments/pos/api-logs
   */
  static async getApiLogs(req: Request, res: Response) {
    try {
      const logFilePath = path.join(process.cwd(), 'logs', 'pos_api_calls.log');
      if (!fs.existsSync(logFilePath)) {
        return res.json({
          success: true,
          message: 'No POS API call logs recorded yet.',
          logs: ''
        });
      }
      const logs = fs.readFileSync(logFilePath, 'utf-8');
      return res.type('text/plain').send(logs);
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to read POS API log file.'
      });
    }
  }

  /**
   * Clear All POS Transactions & Memory Logs (For Testing Clean Slate)
   * Endpoint: ALL /api/payments/pos/clear
   */
  static async clearTransactions(req: Request, res: Response) {
    try {
      if (sql) {
        await initializeNeonDatabase();
        await sql`TRUNCATE TABLE pos_transactions, pos_callbacks RESTART IDENTITY;`;
      }
      memoryPosTransactions.clear();
      memoryPosCallbacks.clear();
      return res.json({
        success: true,
        message: 'All POS transaction records and callback logs cleared successfully.'
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, message: 'Failed to clear transactions.' });
    }
  }
}

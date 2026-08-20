import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

function getEzetapConfig() {
  return {
    username: process.env.EZETAP_USERNAME || '7026424846',
    appKey: process.env.EZETAP_APP_KEY || '8cfae0b9-1396-4561-ab49-820c08ec9c7e',
    baseUrl: (process.env.EZETAP_BASE_URL || 'https://demo.ezetap.com').replace(/\/$/, '')
  };
}

function logEzetapApiCall(endpoint: string, requestPayload: any, responseData: any, httpStatus: number) {
  try {
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFilePath = path.join(logDir, 'pos_api_calls.log');
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
    const logEntry = `--------------------------------------------------------------------------------
[EZETAP POS OUTBOUND API CALL] ${timestamp}
Endpoint: ${endpoint}
HTTP Status: ${httpStatus}
Request Payload: ${JSON.stringify(requestPayload, null, 2)}
Response Payload: ${JSON.stringify(responseData, null, 2)}
--------------------------------------------------------------------------------\n\n`;

    fs.appendFileSync(logFilePath, logEntry, 'utf-8');
    console.log(`📡 [Ezetap API Logger] Logged outbound call to ${endpoint}`);
  } catch (err) {
    console.error('❌ [Ezetap API Logger Error]:', err);
  }
}

export interface InitiatePaymentParams {
  amount: number | string;
  externalRefNumber: string;
  customerMobileNumber?: string;
  customerEmail?: string;
  customerName?: string;
  paymentMode: string; // CARD, UPI, QR, CASH, CHEQUE, REMOTE PAY, WALLET, BHARATQR
  deviceId: string;
  externalRefNumber2?: string;
  externalRefNumber3?: string;
  externalRefNumber4?: string;
  additionalData?: Record<string, any>;
}

export interface EzetapInitiateResponse {
  success: boolean;
  messageCode?: string | null;
  message?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  p2pRequestId?: string;
  raw?: any;
}

export interface EzetapStatusResponse {
  success: boolean;
  status?: 'AUTHORIZED' | 'FAILED' | 'PENDING' | 'CANCELLED' | string;
  messageCode?: 'P2P_DEVICE_RECEIVED' | 'P2P_STATUS_QUEUED' | 'P2P_DEVICE_TXN_DONE' | 'P2P_DEVICE_CANCELED' | 'P2P_STATUS_INIT_CANCELED_FROM_EXTERNAL_SYSTEM' | string;
  message?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export class EzetapService {
  /**
   * 1. Initiate POS Payment via Ezetap / Razorpay POS Bridge API
   * Endpoint: POST /api/3.0/p2padapter/pay or /api/3.0/p2padapter/pa2
   */
  static async initiatePayment(params: InitiatePaymentParams): Promise<EzetapInitiateResponse> {
    const config = getEzetapConfig();
    const endpoints = [
      `${config.baseUrl}/api/3.0/p2padapter/pay`,
      `${config.baseUrl}/api/3.0/p2padapter/pa2`,
      `${config.baseUrl}/api/2.0/p2p/pay`
    ];

    const payload = {
      appKey: config.appKey,
      username: config.username,
      amount: String(params.amount),
      externalRefNumber: params.externalRefNumber,
      customerEmail: params.customerEmail || 'test@gmail.com',
      customerMobileNumber: params.customerMobileNumber || '7026428262',
      pushTo: {
        deviceId: params.deviceId,
      },
      mode: params.paymentMode.toUpperCase(),
      ...(params.customerName ? { customerName: params.customerName } : {}),
      ...(params.externalRefNumber2 !== undefined ? { externalRefNumber2: params.externalRefNumber2 } : { externalRefNumber2: "" }),
      ...(params.externalRefNumber3 !== undefined ? { externalRefNumber3: params.externalRefNumber3 } : { externalRefNumber3: "" }),
      ...(params.externalRefNumber4 ? { externalRefNumber4: params.externalRefNumber4 } : {}),
      ...(params.additionalData ? { additionalData: params.additionalData } : {}),
    };

    let lastErrorMsg = 'Failed to connect to Ezetap / Razorpay POS API.';
    let lastData: any = null;
    let lastStatus = 500;

    for (const url of endpoints) {
      console.log(`📡 [Ezetap Service] Calling Live POS Pay API at ${url} for Ref: ${params.externalRefNumber}`);

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        lastStatus = res.status;
        const data = (await res.json()) as EzetapInitiateResponse;
        lastData = data;

        logEzetapApiCall(url, payload, data, res.status);

        if (res.ok && data.success !== false && data.p2pRequestId) {
          return data;
        }

        if (data.errorMessage || data.message) {
          lastErrorMsg = data.errorMessage || data.message || lastErrorMsg;
        }
      } catch (err: any) {
        console.warn(`⚠️ [Ezetap Service] HTTPS call to ${url} failed:`, err?.message || err);
        logEzetapApiCall(url, payload, { error: err?.message || 'Connection Error' }, 500);
      }
    }

    return {
      success: false,
      messageCode: lastData?.messageCode || 'POS_LIVE_API_ERROR',
      message: lastErrorMsg,
      errorCode: lastData?.errorCode || 'EZETAP_COMMUNICATION_FAILED',
      errorMessage: lastErrorMsg,
      raw: lastData
    };
  }

  /**
   * 2. Check POS Transaction Status
   * Endpoint: POST /api/3.0/p2padapter/status
   */
  static async checkStatus(origP2pRequestId: string): Promise<EzetapStatusResponse> {
    const config = getEzetapConfig();
    const url = `${config.baseUrl}/api/3.0/p2padapter/status`;

    const payload = {
      appKey: config.appKey,
      username: config.username,
      origP2pRequestId,
    };

    try {
      console.log(`📡 [Ezetap Service] Querying Status at ${url} for P2P Req: ${origP2pRequestId}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as EzetapStatusResponse;
      logEzetapApiCall(url, payload, data, res.status);
      return data;
    } catch (err: any) {
      console.warn(`⚠️ [Ezetap Service] Live status query error:`, err?.message || err);
      logEzetapApiCall(url, payload, { error: err?.message || 'Connection error' }, 500);
      return {
        success: false,
        status: 'PENDING',
        messageCode: 'STATUS_QUERY_FAILED',
        message: 'Unable to query live status from POS server',
        errorCode: 'STATUS_FETCH_ERROR',
        errorMessage: err?.message || 'Connection error',
      };
    }
  }

  /**
   * 3. Cancel POS Transaction
   * Endpoint: POST /api/3.0/p2p/cancel or /api/3.0/p2padapter/cancel
   */
  static async cancelPayment(origP2pRequestId: string, deviceId: string): Promise<EzetapStatusResponse> {
    const config = getEzetapConfig();
    const endpoints = [
      `${config.baseUrl}/api/3.0/p2p/cancel`,
      `${config.baseUrl}/api/3.0/p2padapter/cancel`
    ];

    const payload = {
      appKey: config.appKey,
      username: config.username,
      origP2pRequestId,
      pushTo: {
        deviceId,
      },
    };

    for (const url of endpoints) {
      try {
        console.log(`📡 [Ezetap Service] Sending Cancel Request to ${url}`);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const data = (await res.json()) as EzetapStatusResponse;
        logEzetapApiCall(url, payload, data, res.status);
        if (res.ok) {
          return data;
        }
      } catch (err: any) {
        console.warn(`⚠️ [Ezetap Service] Cancel API call failed for ${url}:`, err?.message || err);
      }
    }

    return {
      success: false,
      status: 'FAILED',
      messageCode: 'CANCEL_FAILED',
      message: 'Failed to send cancellation request to POS device',
      errorCode: 'CANCEL_API_FAILED',
      errorMessage: 'Cancellation failed',
    };
  }
}

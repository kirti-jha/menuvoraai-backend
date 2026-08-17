import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { sql, initializeNeonDatabase, authenticateUser, ADMIN_EMAIL } from './config/neon';
import posPaymentRoutes from './routes/posPaymentRoutes';

dotenv.config();

export const app = express();

app.use(cors());
app.use(express.json());

// Initialize Neon PostgreSQL Database schema on startup
initializeNeonDatabase();

// Health Check Endpoint
app.get('/api/health', async (req: Request, res: Response) => {
  let dbStatus = 'NOT_CONNECTED';
  if (sql) {
    try {
      const dbRes = await sql`SELECT NOW();`;
      dbStatus = dbRes ? 'CONNECTED_TO_NEON_POSTGRES' : 'ERROR';
    } catch (e) {
      dbStatus = 'CONNECTION_FAILED';
    }
  }

  res.json({
    status: 'ONLINE',
    service: 'Menuvora AI Node.js Express Backend',
    database: 'Neon DB (Serverless PostgreSQL)',
    dbStatus,
    timestamp: new Date().toISOString(),
  });
});

// Authentication Endpoint (Sign In)
app.post('/api/auth/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: 'Email and password are required.',
    });
  }

  const authResult = await authenticateUser(email, password);

  if (authResult.success) {
    return res.json({
      success: true,
      message: 'Sign in successful!',
      user: authResult.user,
    });
  }

  return res.status(401).json({
    success: false,
    message: authResult.message || 'Invalid email or password.',
  });
});

// Checkout Order Endpoint
app.post('/api/checkout', async (req: Request, res: Response) => {
  const { plan, amount, name, email } = req.body;
  const orderId = `ORD_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;

  if (sql) {
    try {
      await sql`
        INSERT INTO orders (order_id, plan_name, amount, customer_name, customer_email, status)
        VALUES (${orderId}, ${plan || 'Website'}, ${amount || 100}, ${name || 'Customer'}, ${email || ''}, 'COMPLETED');
      `;
    } catch (err) {
      console.error('Neon DB order insert error:', err);
    }
  }

  res.json({
    success: true,
    message: 'Order processed successfully',
    data: {
      orderId,
      plan,
      amount,
      name,
      email,
      status: 'COMPLETED',
    },
  });
});

// Users List Endpoint
app.get('/api/users', async (req: Request, res: Response) => {
  if (sql) {
    try {
      const users = await sql`SELECT id, name, email, role, created_at FROM users ORDER BY id DESC;`;
      return res.json({ success: true, count: users.length, data: users });
    } catch (err) {
      console.error('Fetch users error:', err);
    }
  }

  res.json({
    success: true,
    count: 1,
    data: [{ name: 'Menuvora Admin', email: ADMIN_EMAIL, role: 'ADMIN' }],
  });
});

// Orders List Endpoint
app.get('/api/orders', async (req: Request, res: Response) => {
  if (sql) {
    try {
      const orders = await sql`SELECT * FROM orders ORDER BY id DESC;`;
      return res.json({ success: true, count: orders.length, data: orders });
    } catch (err) {
      console.error('Fetch orders error:', err);
    }
  }

  res.json({ success: true, count: 0, data: [] });
});

// Mount Razorpay POS / Ezetap Bridge Payment Routes
app.use('/api', posPaymentRoutes);

export default app;

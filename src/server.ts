import app from './app';

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Menuvora Backend API running locally on port ${PORT}`);
  console.log(`⚡ Connected to Neon Database (Serverless PostgreSQL)`);
  console.log(`💳 Razorpay POS / Ezetap Bridge endpoints mounted at /api/payments/pos/*`);
});

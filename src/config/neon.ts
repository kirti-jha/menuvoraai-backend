import { neon } from "@neondatabase/serverless";

export const ADMIN_EMAIL = "menuvoraai@gmail.com";
export const ADMIN_PASSWORD = "nonu8198@A";

const databaseUrl = process.env.DATABASE_URL || "";
export const sql = databaseUrl ? neon(databaseUrl) : null;

export async function initializeNeonDatabase() {
  if (!sql) {
    console.log("ℹ️ [Neon DB] DATABASE_URL not set. Running with fallback memory database.");
    return false;
  }

  try {
    // 1. Users table
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'USER',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;

    // 2. Orders table
    await sql`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_id VARCHAR(100) UNIQUE NOT NULL,
        plan_name VARCHAR(100) NOT NULL,
        amount NUMERIC(10, 2) NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        customer_email VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'COMPLETED',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;

    // 3. POS Transactions table (Razorpay POS / Ezetap Bridge)
    await sql`
      CREATE TABLE IF NOT EXISTS pos_transactions (
        id SERIAL PRIMARY KEY,
        transaction_id VARCHAR(100) UNIQUE NOT NULL,
        order_id VARCHAR(100) NOT NULL,
        external_ref_number VARCHAR(100) UNIQUE NOT NULL,
        p2p_request_id VARCHAR(100),
        amount NUMERIC(10, 2) NOT NULL,
        payment_mode VARCHAR(50) NOT NULL,
        device_id VARCHAR(100) NOT NULL,
        status VARCHAR(50) DEFAULT 'PENDING',
        customer_mobile VARCHAR(50),
        customer_email VARCHAR(255),
        initiation_response JSONB,
        final_status_response JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;

    // 4. POS Callbacks table (Server-to-Server Webhooks & Idempotency Audit)
    await sql`
      CREATE TABLE IF NOT EXISTS pos_callbacks (
        id SERIAL PRIMARY KEY,
        p2p_request_id VARCHAR(100) NOT NULL,
        external_ref_number VARCHAR(100) NOT NULL,
        status VARCHAR(50) NOT NULL,
        payload JSONB NOT NULL,
        processed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;

    // 5. Ensure default admin user
    const existingAdmin = await sql`
      SELECT * FROM users WHERE email = ${ADMIN_EMAIL} LIMIT 1;
    `;

    if (existingAdmin.length === 0) {
      await sql`
        INSERT INTO users (name, email, password, role)
        VALUES ('Menuvora Admin', ${ADMIN_EMAIL}, ${ADMIN_PASSWORD}, 'ADMIN');
      `;
      console.log("✅ [Neon DB] Admin user menuvoraai@gmail.com seeded into PostgreSQL!");
    }

    console.log("✅ [Neon DB] PostgreSQL schema ready (Users, Orders, POS Transactions, POS Callbacks)!");
    return true;
  } catch (error) {
    console.error("❌ [Neon DB] Initialization Error:", error);
    return false;
  }
}

export async function authenticateUser(emailInput: string, passwordInput: string) {
  const cleanEmail = emailInput.toLowerCase().trim();
  const cleanPassword = passwordInput.trim();

  if (sql) {
    try {
      await initializeNeonDatabase();
      const users = await sql`
        SELECT id, name, email, password, role 
        FROM users 
        WHERE LOWER(email) = ${cleanEmail} 
        LIMIT 1;
      `;

      if (users.length > 0) {
        const user = users[0];
        if (user.password === cleanPassword) {
          return {
            success: true,
            user: {
              id: user.id,
              name: user.name,
              email: user.email,
              role: user.role,
            },
          };
        }
      }
    } catch (err) {
      console.error("Neon DB authentication error:", err);
    }
  }

  // Fallback credentials check
  if (cleanEmail === ADMIN_EMAIL && cleanPassword === ADMIN_PASSWORD) {
    return {
      success: true,
      user: {
        name: "Menuvora Admin",
        email: ADMIN_EMAIL,
        role: "ADMIN",
      },
    };
  }

  return {
    success: false,
    message: "Invalid email or password. Please try again.",
  };
}

import express from "express";
import * as dotenv from "dotenv";
import { authenticateApiKey } from "./middleware/auth";
import discoveryRoutes from "./routes/discovery";
import listingsRoutes from "./routes/listings";
import reservationsRoutes from "./routes/reservations";
import redemptionsRoutes from "./routes/redemptions";
import adminRoutes from "./routes/admin";
import merchantWalletsRoutes from "./routes/merchantWallets";

dotenv.config();

const app = express();

app.use(express.json());

// Register Global Authentication Middleware (Extracts Bearer token if present)
app.use(authenticateApiKey);

// Register API Route Modules
app.use(discoveryRoutes);
app.use(listingsRoutes);
app.use(reservationsRoutes);
app.use(redemptionsRoutes);
app.use(adminRoutes);
app.use(merchantWalletsRoutes);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

export default app;

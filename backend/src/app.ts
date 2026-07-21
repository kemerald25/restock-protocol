import express from "express";
import * as dotenv from "dotenv";
import { authenticateApiKey } from "./middleware/auth";
import { rateLimitMiddleware } from "./middleware/rateLimit";
import { auditLogMiddleware } from "./middleware/audit";
import discoveryRoutes from "./routes/discovery";
import listingsRoutes from "./routes/listings";
import reservationsRoutes from "./routes/reservations";
import redemptionsRoutes from "./routes/redemptions";
import adminRoutes from "./routes/admin";
import merchantWalletsRoutes from "./routes/merchantWallets";
import merchantRoutes from "./routes/merchant";

dotenv.config();

const app = express();

app.use(express.json());

// Register Global Middleware Pipeline
app.use(authenticateApiKey);
app.use(rateLimitMiddleware);
app.use(auditLogMiddleware);

// Register API Route Modules
app.use(discoveryRoutes);
app.use(listingsRoutes);
app.use(reservationsRoutes);
app.use(redemptionsRoutes);
app.use(adminRoutes);
app.use(merchantWalletsRoutes);
app.use(merchantRoutes);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

export default app;

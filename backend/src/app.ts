import express from "express";
import * as dotenv from "dotenv";
import discoveryRoutes from "./routes/discovery";
import listingsRoutes from "./routes/listings";
import reservationsRoutes from "./routes/reservations";
import redemptionsRoutes from "./routes/redemptions";
import adminRoutes from "./routes/admin";

dotenv.config();

const app = express();

app.use(express.json());

// Register API Route Modules
app.use(discoveryRoutes);
app.use(listingsRoutes);
app.use(reservationsRoutes);
app.use(redemptionsRoutes);
app.use(adminRoutes);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

export default app;

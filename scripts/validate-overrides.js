import { ConvexHttpClient } from "convex/browser";
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const CONVEX_URL = process.env.VITE_CONVEX_URL;
if (!CONVEX_URL) {
    console.error("VITE_CONVEX_URL is not defined.");
    process.exit(1);
}

const client = new ConvexHttpClient(CONVEX_URL);

async function validate() {
    console.log("Fetching routes (en) from Convex...");
    const routes = await client.query("transit:getRoutes", { sourceId: "tbilisi", locale: "en" });
    console.log(`Fetched ${routes.length} routes.`);

    if (routes.length === 0) {
        console.error("No routes found! Did sync-tbilisi-convex.js finish?");
        return;
    }

    const firstRoute = routes[0];
    console.log("Sample Route ID in DB:", firstRoute.id);

    // Check for Route 306 which definitely has true at the end of CSV
    const r306 = routes.find(r => r.shortName === "306");
    if (r306) {
        console.log("Found Route 306:", r306.id, r306.longName);
        console.log("Has invertDirection?", r306.invertDirection);

        if (r306.invertDirection === true) {
            console.log("SUCCESS: InvertDirection is TRUE. Overrides are working!");
        } else {
            console.warn("FAILURE: InvertDirection is missing/false.");
            console.log(`DB Route ID: '${r306.id}'`);
        }
    } else {
        console.log("Route 306 not found in DB.");
    }
}

validate().catch(console.error);

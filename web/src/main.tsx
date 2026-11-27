import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Portfolio from "./pages/Portfolio";
import PayoutsPage from "./app/PayoutsPage";
import InvestorsPage from "./app/InvestorsPage";
import Messages from "./app/Messages";
import { ThirdwebProvider } from "thirdweb/react";
import "./styles.css";
import { TenantProvider } from "./lib/tenant";
import GeoGate from "./lib/GeoGate";
import Landing from "./pages/Landing";
import Layout from "./app/Layout";
import Dashboard from "./app/Dashboard";
import NewIssuance from "./app/NewIssuance";
import Branding from "./app/Branding";
import Payments from "./app/Payments";
import Guide from "./app/Guide";
import AssetDetail from "./app/AssetDetail";
import { GoLive } from "./app/Wizards";
import Invest from "./pages/Invest";
import Billing from "./app/Billing";
import Pricing from "./pages/Pricing";
import Legal from "./pages/Legal";
import Verify from "./pages/Verify";
import Start, { StartJoin, StartWorkspace } from "./pages/Start";
import Technology from "./pages/Technology";
import Markets from "./pages/Markets";
import MarketsArticle from "./pages/MarketsArticle";
import Builder from "./pages/Builder";
import Team from "./app/Team";
import SecurityPage from "./app/Security";
import Clients from "./app/Clients";
import ClientPortal from "./pages/ClientPortal";
import Reviews from "./app/Reviews";
import Counsel from "./pages/Counsel";
import SignRequest from "./pages/SignRequest";
import Signing from "./app/Signing";
import EntityInvest from "./pages/EntityInvest";
import UseCasePage, { UseCasesIndex } from "./pages/UseCases";
import Accredit from "./pages/Accredit";
import { MarketItem, MarketList } from "./pages/Market";
import { IpAssetPage, LicenseCertificate, LicenseCheckout } from "./pages/IP";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GeoGate>
    <ThirdwebProvider>
    <TenantProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/market" element={<MarketList />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/market/:id" element={<MarketItem />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/accredit/:id" element={<Accredit />} />
          <Route path="/legal/:doc" element={<Legal />} />
          <Route path="/verify/:id" element={<Verify />} />
          <Route path="/invest/entity" element={<EntityInvest />} />
          <Route path="/invest/:id" element={<Invest />} />
          <Route path="/ip/:id" element={<IpAssetPage />} />
          <Route path="/ip/:id/license/:key" element={<LicenseCheckout />} />
          <Route path="/license/:chainId/:licenseId" element={<LicenseCertificate />} />
          <Route path="/start" element={<Start />} />
          <Route path="/technology" element={<Technology />} />
          <Route path="/markets" element={<Markets />} />
          <Route path="/markets/how-we-use-market-data" element={<MarketsArticle />} />
          <Route path="/builder" element={<Builder />} />
          <Route path="/use-cases" element={<UseCasesIndex />} />
          <Route path="/use-cases/:slug" element={<UseCasePage />} />
          <Route path="/start/workspace" element={<StartWorkspace />} />
          <Route path="/start/join" element={<StartJoin />} />
          <Route path="/client/:token" element={<ClientPortal />} />
          <Route path="/counsel/:token" element={<Counsel />} />
          <Route path="/sign/:token" element={<SignRequest />} />
          <Route path="/app" element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="new" element={<NewIssuance />} />
            <Route path="branding" element={<Branding />} />
            <Route path="team" element={<Team />} />
            <Route path="security" element={<SecurityPage />} />
            <Route path="clients" element={<Clients />} />
            <Route path="reviews" element={<Reviews />} />
            <Route path="signing" element={<Signing />} />
            <Route path="payments" element={<Payments />} />
            <Route path="payouts" element={<PayoutsPage />} />
            <Route path="investors" element={<InvestorsPage />} />
            <Route path="messages" element={<Messages />} />
            <Route path="guide" element={<Guide />} />
            <Route path="assets/:id" element={<AssetDetail />} />
            <Route path="assets/:id/go-live" element={<GoLive />} />
            <Route path="billing" element={<Billing />} />
          </Route>
          <Route path="*" element={<Landing />} />
        </Routes>
      </BrowserRouter>
    </TenantProvider>
    </ThirdwebProvider>
    </GeoGate>
  </StrictMode>,
);

// Installable app (PWA): register the service worker in production builds only, so local dev never caches.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => { /* app still works without it */ }); });
}

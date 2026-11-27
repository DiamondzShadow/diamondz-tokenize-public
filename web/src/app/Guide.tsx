import { useState } from "react";
import { Link } from "react-router-dom";
import { WelcomeTour } from "./onboarding";

export default function Guide() {
  const [tour, setTour] = useState(false);
  return (
    <>
      <div className="topbar">
        <h1>Guide</h1>
        <button className="btn ghost sm" onClick={() => setTour(true)}>Replay welcome tour</button>
      </div>
      <div className="content guide">
        <div className="panel">
          <h2>How tokenizing an asset works</h2>
          <p>You take something that earns money or holds value, put it in a legal wrapper, and issue tokens that represent shares of it. Investors buy the tokens and receive their share of the income. Here is the full path, start to finish.</p>
          <ol>
            <li><b>Set up the legal side.</b> Usually the asset goes into its own company (an SPV or LLC). Your lawyer picks the offering exemption, such as Reg D 506(c) for accredited US investors or Reg S for investors outside the US.</li>
            <li><b>Brand and configure your site.</b> Name, logo, colors, which asset types you offer, and where money goes. <Link to="/app/branding">Branding</Link> · <Link to="/app/payments">Payments</Link></li>
            <li><b>Create the asset.</b> The wizard asks what you're tokenizing, recommends a token standard, and collects the terms: supply, price, minimum, payout schedule and lockup. <Link to="/app/new">New issuance</Link></li>
            <li><b>Verify investors.</b> Each investor passes identity (KYC), anti-money-laundering and, if required, accreditation checks. Their wallet is then marked as verified on chain, with no personal data stored there.</li>
            <li><b>Deploy the token.</b> First on a test network to rehearse, then on the live network after sign-off. Admin control goes to your multisig wallet, not to us.</li>
            <li><b>Take subscriptions.</b> Investors pay by card, bank or stablecoin and receive tokens in their wallet.</li>
            <li><b>Pay income.</b> When the asset earns (rent, royalties, interest), you fund a distribution and every holder can claim their share. A small platform fee is added on top, so holders receive the full amount.</li>
          </ol>
        </div>

        <div className="panel">
          <h2>What you need ready</h2>
          <ul>
            <li>A lawyer who handles securities offerings, and the legal entity that holds the asset.</li>
            <li>A multisig wallet (for example Safe) with at least two signers. It controls the token and receives raises.</li>
            <li>Offering documents: private placement memorandum, subscription agreement, operating agreement.</li>
            <li>Proof of the asset: title, appraisal, reserve report, royalty statements, whatever fits the asset.</li>
          </ul>
        </div>

        <div className="panel">
          <h2>Which token should I pick?</h2>
          <ul>
            <li><b>One building, one company, one loan:</b> ERC-7943 permissioned token. Each token is a share; only verified investors can hold it.</li>
            <li><b>A pool of many assets or a fund:</b> ERC-4626 vault. Investors deposit stablecoins and get shares of the pool; the share price tracks the pool's value.</li>
            <li><b>A single unique item, or fixed fractions of one:</b> ERC-721 or ERC-1155.</li>
            <li><b>Music, film or brand rights:</b> a permissioned token for investors, plus an official record and licensing in the IP registry on your offering's network.</li>
          </ul>
          <p>The wizard pre-selects the recommended one for your asset type, so you can usually keep the default.</p>
        </div>

        <div className="panel">
          <h2>Glossary</h2>
          <dl>
            <dt>Token</dt><dd>A digital record of ownership on a blockchain. Here, one token is one share of the asset.</dd>
            <dt>KYC / AML</dt><dd>Know Your Customer and Anti-Money-Laundering checks: confirming who an investor is and that they aren't sanctioned.</dd>
            <dt>Accredited investor</dt><dd>A US investor who meets income or net-worth tests. Many private offerings are limited to them.</dd>
            <dt>Exemption (Reg D, Reg S)</dt><dd>The legal rule that lets you sell securities without a full public registration. Your counsel picks it.</dd>
            <dt>Multisig</dt><dd>A wallet that needs several people to approve each transaction. It protects admin control of the token.</dd>
            <dt>Stablecoin</dt><dd>A token pegged to a currency, like USDC (US dollar). Used for payments and payouts.</dd>
            <dt>Testnet / mainnet</dt><dd>A testnet is a practice network with fake money. Mainnet is the real network.</dd>
            <dt>Distribution</dt><dd>A payout of income to all holders, split by how many tokens each holds.</dd>
            <dt>Lockup</dt><dd>A period after purchase when investors can't resell their tokens, often required by the exemption.</dd>
          </dl>
        </div>
      </div>
      {tour && <WelcomeTour onClose={() => setTour(false)} />}
    </>
  );
}

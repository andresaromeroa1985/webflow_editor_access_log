import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Webflow Editor Access Log",
  description: "Which SpotOn client sites are actually being edited by clients.",
};

const basePath = process.env.BASE_URL || "";

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="wrap">
          <header className="masthead">
            <div>
              <h1>Webflow Editor Access Log</h1>
              <div className="meta">
                Client edit activity across the SpotOn site portfolio
              </div>
            </div>
            <nav className="nav">
              <a href={`${basePath}/`}>Dashboard</a>
              <a href={`${basePath}/domains`}>Domains</a>
              <a href={`${basePath}/users`}>Users</a>
              <a href={`${basePath}/api/stats?days=30&format=csv`}>CSV</a>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}

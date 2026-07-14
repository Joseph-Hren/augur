import { Montserrat } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";

const montserrat = Montserrat({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
});

export const metadata = {
  title: "AUGUR",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={montserrat.className}
      style={{ backgroundColor: "#1D3842" }}
    >
      <body
        style={{
          margin: 0,
          backgroundColor: "#1D3842",
          display: "flex",
          flexDirection: "column",
          minHeight: "100vh",
        }}
      >
        {children}
        <Analytics />
      </body>
    </html>
  );
}

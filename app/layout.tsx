import "./globals.css";
import { Public_Sans } from "next/font/google";

const publicSans = Public_Sans({ subsets: ["latin"] });

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <title>Chat</title>
        <meta name="description" content="A simple chat interface." />
      </head>
      {/* NOTE: Use correct backtick syntax for className */}
      <body className={`${publicSans.className} bg-white text-gray-900`}>
        <div className="flex flex-col items-center justify-center min-h-screen p-4">
          <h1 className="text-2xl font-semibold mb-4">Chat</h1>
          <div className="w-full max-w-2xl">{children}</div>
        </div>
      </body>
    </html>
  );
}

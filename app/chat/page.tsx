"use client";

import { ChatWindow } from "@/components/ChatWindow";

export default function ChatIELTSPage() {
  // Minimal info box with little to no extra spacing
  const InfoCard = (
    <div className="bg-gray-50 border border-gray-200 rounded-md p-4">
      <h1 className="text-xl font-semibold">IELTS Introduction Practice</h1>
      <p>
        This chatbot helps students practice <strong>IELTS writing introduction Part 2</strong> by providing structured feedback.
      </p>
      <ul className="list-disc list-inside">
        <li>Submit your Part 2 introductions for evaluation.</li>
        <li>Receive structured feedback based on IELTS criteria.</li>
        <li>Improve fluency, coherence, and vocabulary.</li>
      </ul>
      <p>
        Enter your <strong>IELTS writing Part 2</strong> response below to get started.
      </p>
    </div>
  );

  return (
    // Use zero padding & no gap to bring elements closer
    <div className="flex flex-col gap-0">
      {/* 16:9 YouTube Embed with zero margin */}
      <div className="w-full aspect-video border border-gray-300 rounded-md overflow-hidden">
        <iframe
          className="w-full h-full"
          src="https://www.youtube.com/embed/zGM30-iAoZA"
          frameBorder="0"
          allowFullScreen
        />
      </div>

      {/* Chatbot Window (no extra margin) */}
      <ChatWindow
        endpoint="/api/chat"
        titleText="IELTS Introduction Assistant"
        placeholder="Enter your IELTS Part 2 introduction..."
        emptyStateComponent={InfoCard}
      />
    </div>
  );
}

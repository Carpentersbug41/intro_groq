"use client";

import { useState, useEffect, FormEvent, useRef } from "react";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import ReactMarkdown from "react-markdown";

type Message = {
  role: "user" | "assistant";
  content: string;
};

export function ChatWindow2(props: {
  endpoint: string;
  placeholder?: string;
  titleText?: string;
  emptyStateComponent?: React.ReactNode;
  videoId?: string;
}) {
  const {
    endpoint,
    placeholder = "Type your message...",
    titleText = "Professional Chat",
    emptyStateComponent,
    videoId,
  } = props;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [apiKey, setApiKey] = useState<string>("");
  const [isApiKeyValid, setIsApiKeyValid] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const messageContainerRef = useRef<HTMLDivElement | null>(null);

  // Load API Key from localStorage on mount
  useEffect(() => {
    const savedKey = localStorage.getItem("groq_api_key") || "";
    console.log("✅ Frontend stored API key on mount:", savedKey);
    setApiKey(savedKey);
  }, []);

  // Handle changes to API key input
  const handleApiKeyChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newKey = event.target.value.trim();
    console.log("🔑 User entered API key:", newKey);

    if (newKey) {
      localStorage.setItem("groq_api_key", newKey);
      console.log("✅ API Key successfully saved to Local Storage:", newKey);
    } else {
      localStorage.removeItem("groq_api_key");
    }

    setApiKey(newKey);
  };

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isSubmitting) return;
    if (!input.trim()) {
      toast.warning("Please enter a message.");
      return;
    }
    if (!apiKey.trim()) {
      toast.warning("Please enter your Groq API key.");
      return;
    }

    console.log("🚀 Sending API Key to Backend:", apiKey);
    setIsSubmitting(true);

    const userMessage: Message = { role: "user", content: input.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");

    try {
      const requestBody = {
        message: userMessage.content,
        apiKey: apiKey,
        stream: false,
      };

      console.log("📤 Sending request to backend:", JSON.stringify(requestBody, null, 2));

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        let errorDetails: any;
        try {
          errorDetails = await res.json();
        } catch {
          errorDetails = await res.text();
        }
        console.error("❌ Error response details:", errorDetails);

        if (res.status === 401) {
          setIsApiKeyValid(false);
          throw new Error("Invalid API key. Please check and try again.");
        }
        throw new Error(`Error ${res.status}: ${JSON.stringify(errorDetails)}`);
      }

      setIsApiKeyValid(true);

      const responseText = await res.text();
      console.log("🤖 Assistant Response (raw text):", responseText);

      const assistantContent = responseText || "Error: No response content.";
      setMessages((prev) => [...prev, { role: "assistant", content: assistantContent }]);
    } catch (err: any) {
      console.error("❌ Caught error in handleSubmit:", err);
      toast.error("Error: " + err.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  function renderMessage(msg: Message, index: number) {
    const isUser = msg.role === "user";
    const bubbleClasses = isUser
      ? "bg-blue-50 text-blue-800 self-end"
      : "bg-gray-100 text-gray-800 self-start";

    return (
      <div key={index} className={`p-3 rounded-md ${bubbleClasses}`}>
        {isUser ? (
          <p>{msg.content}</p>
        ) : (
          <ReactMarkdown>{msg.content}</ReactMarkdown>
        )}
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl mx-auto flex flex-col bg-white text-gray-900 p-4">
      {/* Title */}
      <div className="mb-3">
        <h2 className="text-xl font-semibold">{titleText}</h2>
      </div>

{/* Optional YouTube Video */}
{videoId && (
  <div className="mb-3 w-full relative" style={{ paddingTop: "56.25%" }}>
    <iframe
      className="absolute top-0 left-0 w-full h-full"
      src={`https://www.youtube.com/embed/${videoId}`}
      frameBorder="0"
      allowFullScreen
    />
  </div>
)}

      {/* API Key Input */}
      <div className="mb-3">
        <input
          type="password"
          placeholder="Enter your Groq API key"
          value={apiKey}
          onChange={handleApiKeyChange}
          className={`w-full p-2 border rounded-md ${
            isApiKeyValid ? "border-gray-300" : "border-red-500"
          }`}
        />
        {!isApiKeyValid && (
          <p className="text-red-500 text-sm mt-1">
            Invalid API key. Please try again.
          </p>
        )}
      </div>

      {/* If no API key, show a friendly message */}
      {!apiKey.trim() ? (
        <div className="p-3 text-center border border-yellow-300 bg-yellow-50 rounded-md">
          <p className="text-yellow-700 font-medium">
            Please enter your Groq API key to start chatting.
          </p>
        </div>
      ) : (
        <>
          {/* 
            The key is min-h and max-h. 
            Enough to avoid collapsing, but not too big. 
          */}
          <div
            ref={messageContainerRef}
            className="flex flex-col mb-3 p-2 space-y-2 overflow-auto border border-gray-200 rounded-md"
            style={{
              minHeight: "600px", // ensures there's some space even if empty
              maxHeight: "600px", // doesn't get too large
            }}
          >
            {messages.length === 0 && emptyStateComponent
              ? emptyStateComponent
              : messages.map((m, idx) => renderMessage(m, idx))}
          </div>

          {/* Input Form */}
          <form onSubmit={handleSubmit} className="flex">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={placeholder}
              className="flex-grow p-2 mr-2 border border-gray-300 rounded-md"
              disabled={!apiKey.trim()}
            />
            <button
              type="submit"
              className={`bg-blue-500 text-white px-4 py-2 rounded-md ${
                isSubmitting ? "opacity-50 cursor-not-allowed" : ""
              }`}
              disabled={!apiKey.trim() || isSubmitting}
            >
              {isSubmitting ? "Sending..." : "Send"}
            </button>
          </form>
        </>
      )}

      <ToastContainer />
    </div>
  );
}

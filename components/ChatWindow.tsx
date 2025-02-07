"use client";

import { useState, useEffect, FormEvent, useRef } from "react";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import ReactMarkdown from "react-markdown";

type Message = {
  role: "user" | "assistant";
  content: string;
};

export function ChatWindow(props: {
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
  const [apiKey, setApiKey] = useState<string>(""); // Always start as an empty string
  const [isApiKeyValid, setIsApiKeyValid] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false); // ✅ Prevents double-submit

  const messageContainerRef = useRef<HTMLDivElement | null>(null);

  // ✅ Load API Key from localStorage on mount (default to empty string if missing)
  useEffect(() => {
    const savedKey = localStorage.getItem("groq_api_key") || "";
    setApiKey(savedKey);
  }, []);

  // ✅ Handle API Key input changes & store in localStorage
  const handleApiKeyChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newKey = event.target.value.trim();
    setApiKey(newKey); // Always keep it as a string (even if empty)
    if (newKey) {
      localStorage.setItem("groq_api_key", newKey);
    } else {
      localStorage.removeItem("groq_api_key");
    }
  };

  useEffect(() => {
    if (messageContainerRef.current) {
      messageContainerRef.current.scrollTop = messageContainerRef.current.scrollHeight;
    }
  }, [messages]);

  // ✅ Function to send messages to the backend (includes API key)
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    if (isSubmitting) return; // ✅ Ignore if already submitting

    if (!input.trim()) {
      toast.warning("Please enter a message.");
      return;
    }
    if (!apiKey.trim()) {
      toast.warning("Please enter your Groq API key.");
      return;
    }

    setIsSubmitting(true); // ✅ Lock input while processing

    const userMessage: Message = { role: "user", content: input.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: userMessage.content,
          apiKey: apiKey, // ✅ Send API Key with request
        }),
      });

      if (!res.ok) {
        if (res.status === 401) {
          setIsApiKeyValid(false);
          throw new Error("Invalid API key. Please check and try again.");
        }
        throw new Error("Failed to send message to the server.");
      }

      setIsApiKeyValid(true);
      const assistantResponse = await res.text();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: assistantResponse },
      ]);
    } catch (err: any) {
      toast.error("Error: " + err.message);
    } finally {
      setIsSubmitting(false); // ✅ Unlock input after processing
    }
  }

  function renderMessage(msg: Message, index: number) {
    const isUser = msg.role === "user";
    const bubbleClasses = isUser
      ? "bg-blue-50 text-blue-800 self-end"
      : "bg-gray-100 text-gray-800 self-start";

    return (
      <div key={index} className={`p-3 mb-2 rounded-md ${bubbleClasses}`}>
        {isUser ? (
          <p>{msg.content}</p>
        ) : (
          <ReactMarkdown>{msg.content}</ReactMarkdown>
        )}
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl mx-auto min-h-screen flex flex-col bg-white text-gray-900 p-4">
      {/* Title */}
      <div className="mb-4">
        <h2 className="text-2xl font-semibold">{titleText}</h2>
      </div>

      {/* Optional YouTube Video */}
      {videoId && (
        <div className="mb-4 w-full h-60 border border-gray-300 rounded-md overflow-hidden">
          <iframe
            width="100%"
            height="100%"
            src={`https://www.youtube.com/embed/${videoId}`}
            frameBorder="0"
            allowFullScreen
          ></iframe>
        </div>
      )}

      {/* ✅ API Key Input (Always Visible) */}
      <div className="mb-4">
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

      {/* ✅ If API key is empty, show a friendly message but keep input visible */}
      {!apiKey.trim() ? (
        <div className="p-4 text-center border border-yellow-300 bg-yellow-50 rounded-md">
          <p className="text-yellow-700 font-medium">
            Please enter your Groq API key to start chatting.
          </p>
        </div>
      ) : (
        <>
          {/* ✅ Message History */}
          <div
            ref={messageContainerRef}
            className="flex flex-col mb-4 p-2 space-y-2 overflow-auto border border-gray-200 rounded-md grow"
          >
            {messages.length === 0 && emptyStateComponent
              ? emptyStateComponent
              : messages.map((m, idx) => renderMessage(m, idx))}
          </div>

          {/* ✅ Input Form */}
          <form onSubmit={handleSubmit} className="flex">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={placeholder}
              className="flex-grow p-2 mr-2 border border-gray-300 rounded-md"
              disabled={!apiKey.trim() || isSubmitting} // ✅ Disable if API key is missing or sending
            />
            <button
              type="submit"
              className={`bg-blue-500 text-white px-4 py-2 rounded-md ${isSubmitting ? "opacity-50 cursor-not-allowed" : ""}`}
              disabled={!apiKey.trim() || isSubmitting} // ✅ Disable if API key is missing or sending
            >
              {isSubmitting ? "Sending..." : "Send"} {/* ✅ Shows "Sending..." while waiting */}
            </button>
          </form>
        </>
      )}

      <ToastContainer />
    </div>
  );
}

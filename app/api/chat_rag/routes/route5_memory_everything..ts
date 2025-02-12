import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

// Here you can toggle `autoTransition: true` for any prompt you want
// to trigger this "second API call" flow automatically.
const PROMPT_LIST = [
  { prompt_text: "Ask the user what their favorite color is.",  },
  { prompt_text: "Ask the user what their favorite dish is.", important_memory: true  },
  { prompt_text: "Ask the user what their favorite type of music is.",autoTransition: true, hidden:true, },
  { prompt_text: "Ask the user what their favorite movie is." },
  { prompt_text: "Ask the user what their favorite book is." },
  { prompt_text: "Ask the user what their dream vacation destination is."},
  { prompt_text: "Ask the user what their favorite animal is." },
  { prompt_text: "Ask the user what their favorite hobby is." },
];

let conversationHistory: { role: string; content: string }[] = [];
let currentIndex = 0;

const BUFFER_SIZE = 6; // Maximum number of messages to retain (3 exchanges: 3 user + 3 assistant)

/**
 * Trims conversation history to retain the most recent BUFFER_SIZE messages.
 */
function manageBuffer(conversationHistory) {
  console.log(`[DEBUG] Current Conversation History Length: ${conversationHistory.length}`);

  const systemMessage = conversationHistory.find((entry) => entry.role === "system");
  // Lines that start with "Important_memory:" must be preserved
  const importantMemoryLines = conversationHistory.filter(
    (entry) =>
      entry.role === "assistant" &&
      entry.content.trim().startsWith("Important_memory:")
  );

  // All other lines
  const otherMessages = conversationHistory.filter(
    (entry) =>
      entry !== systemMessage && !importantMemoryLines.includes(entry)
  );

  if (otherMessages.length > BUFFER_SIZE) {
    const excessCount = otherMessages.length - BUFFER_SIZE;
    console.log(`[DEBUG] Trimming ${excessCount} oldest non-system, non-important messages.`);

    // Trim only the 'other' messages
    const trimmed = otherMessages.slice(excessCount);
    // Reconstruct final array: system message + importantMemory + trimmed
    const finalHistory = [systemMessage, ...importantMemoryLines, ...trimmed].filter(Boolean);

    console.log("[DEBUG] Trimmed Conversation History (with Important Memory Kept):",
      JSON.stringify(finalHistory, null, 2)
    );
    return finalHistory;
  }

  // If not exceeding buffer, just return as is
  return conversationHistory;
}



/**
 * Basic fetch to the API.
 */
async function fetchApiResponse(payload: any): Promise<string | null> {
  console.log("\n[DEBUG] Sending Payload to API:\n", JSON.stringify(payload, null, 2));

  const startTime = Date.now();
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const latency = Date.now() - startTime;
    console.log(`[DEBUG] API Call Latency: ${latency}ms`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ERROR] API call failed:\n", errorText);
      throw new Error(`API error: ${response.statusText}`);
    }

    const responseData = await response.json();
    const assistantContent = responseData.choices?.[0]?.message?.content;

    if (!assistantContent) {
      console.warn("[WARN] API returned no content. Raw response:\n", JSON.stringify(responseData, null, 2));
      return null;
    }

    console.log("[DEBUG] API Response Content:\n", assistantContent);
    return assistantContent;
  } catch (error: any) {
    console.error("[ERROR] Failed to fetch API response:\n", error.message);
    return null;
  }
}

/**
 * A second fetch call with basic retry logic, to demonstrate
 * how you might re-try if there's a transient error.
 */
async function fetchApiResponseWithRetry(payload: any, retries = 2, delayMs = 500): Promise<string | null> {
  let attempt = 0;
  while (attempt < retries) {
    attempt++;
    console.log(`[DEBUG] Retry Attempt: ${attempt}/${retries}`);
    const response = await fetchApiResponse(payload);
    if (response) return response;

    console.warn(`[WARN] Attempt ${attempt} failed. Retrying in ${delayMs}ms...`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

/**
 * Minimal validation call: returns true if "VALID", else false.
 */
async function validateInput(userInput: string, currentPrompt: string): Promise<boolean> {
  const validationInstruction = `
    You are a validation assistant.
    Your task is to assess whether the user's input matches the prompt's requirements.
    Current prompt: '${currentPrompt}'
    User input: '${userInput}'
    
    Respond with only one word: "VALID" if the input matches the prompt's requirement,
    or "INVALID" if it does not.
    Do not provide any additional explanation or description.
  `;

  const payload = {
    model: "llama3-8b-8192",
    messages: [{ role: "system", content: validationInstruction }],
    max_tokens: 512,
    temperature: 0.7,
    top_p: 1,
    n: 1,
    stream: false,
  };

  console.log("[DEBUG] Validation Payload:\n", JSON.stringify(payload, null, 2));
  const response = await fetchApiResponse(payload);
  console.log(`[DEBUG] Validation Result: ${response}`);
  return response === "VALID";
}

/**
 * Generates a dynamic retry message if the user’s input is invalid.
 */
async function generateRetryMessage(userInput: string, currentPrompt: string): Promise<string> {
  const payload = {
    model: "llama3-8b-8192",
    messages: [
      { role: "system", content: currentPrompt },
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ],
    max_tokens: 512,
    temperature: 0.7,
    top_p: 1,
    n: 1,
    stream: false,
  };

  console.log("[DEBUG] Retry Message Payload:\n", JSON.stringify(payload, null, 2));
  return (await fetchApiResponse(payload)) || "I'm sorry, I couldn't process that. Can you try again?";
}

/**
 * Main request handler.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const userMessage = body.message?.trim();

    console.log("\n[INFO] Received User Input:", userMessage || "[No Input Provided]");

    if (!userMessage) {
      console.log("[WARN] No User Input Received. Returning Error.");
      return new Response("No input received. Please try again.", { status: 400 });
    }

    const currentPrompt = PROMPT_LIST[currentIndex]?.prompt_text;
    const isAutoTransition = PROMPT_LIST[currentIndex]?.autoTransition || false;

    console.log("\n[DEBUG] Current Prompt:\n", currentPrompt);
    console.log("[DEBUG] AutoTransition Status:", isAutoTransition);

    if (!currentPrompt) {
      const finalMessage = "Thank you for your responses! Goodbye.";
      conversationHistory.push({ role: "assistant", content: finalMessage });
      console.log("[INFO] Conversation Complete. Final Message Sent.");
      return new Response(finalMessage, { status: 200 });
    }

    conversationHistory = [
      { role: "system", content: currentPrompt },
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ];
    console.log("[DEBUG] Updated Conversation History (System Prompt First):\n", JSON.stringify(conversationHistory, null, 2));

    conversationHistory.push({ role: "user", content: userMessage });
    console.log("[DEBUG] Adding User Input to Conversation History.");

    // Apply buffer management here
    conversationHistory = manageBuffer(conversationHistory);

    console.log("[INFO] Validating User Input with prompt:", currentPrompt);
    const isValid = await validateInput(userMessage, currentPrompt);

    if (!isValid) {
      console.log("[INFO] Validation Failed. Retrying the Same Prompt.");
      const retryMessage = await generateRetryMessage(userMessage, currentPrompt);
      conversationHistory.push({ role: "assistant", content: retryMessage });
      console.log("[DEBUG] Retry Message Added to Conversation History.");
      conversationHistory = manageBuffer(conversationHistory); // Trim buffer after retry
      return new Response(retryMessage, { status: 200 });
    }

    console.log("[INFO] User Input Validated Successfully.");
    currentIndex++;
    console.log("[DEBUG] Updated Current Index:", currentIndex);

    const nextPrompt = PROMPT_LIST[currentIndex]?.prompt_text || "No further prompts.";
    console.log("[DEBUG] Next Prompt to Be Processed:", nextPrompt);

    conversationHistory = [
      { role: "system", content: nextPrompt },
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ];
    console.log("[DEBUG] Updated Conversation History for Next Prompt (System Prompt First):\n", JSON.stringify(conversationHistory, null, 2));

    // Apply buffer management here before the payload is prepared
    conversationHistory = manageBuffer(conversationHistory);

    const payload1 = {
      model: "llama3-8b-8192",
      messages: conversationHistory,
      max_tokens: 512,
      temperature: 0.7,
      top_p: 1,
      n: 1,
      stream: false,
    };

    console.log("[DEBUG] Token Count for First Call Payload:", payload1.messages.length);
    const assistantContent1 = await fetchApiResponse(payload1);

    if (!assistantContent1) {
      console.warn("[WARN] First API call returned no content. Skipping second call.");
      return new Response("I'm sorry, I couldn't process your response. Please try again.", { status: 200 });
    }

    conversationHistory.push({ role: "assistant", content: assistantContent1 });
    console.log("[DEBUG] First API Response Added to Conversation History.");

    // If the previous prompt is marked as important_memory, add an Important Memory line
if (PROMPT_LIST[currentIndex - 1]?.important_memory) {
  // Insert the important-memory line AFTER the system message
  // i.e. at index 1 if system message is at index 0
  const systemIndex = conversationHistory.findIndex((msg) => msg.role === "system");
  const insertIndex = systemIndex + 1; // just after the system message

  conversationHistory.splice(insertIndex, 0, {
    role: "assistant",
    content: `Important_memory: ${assistantContent1}`
  });

  console.log("[DEBUG] Important Memory Added to Conversation History at index:", insertIndex);
}

    

    // Apply buffer management here after adding assistant response
    conversationHistory = manageBuffer(conversationHistory);
    

    if (isAutoTransition) {
      conversationHistory.push({ role: "user", content: "OK" });
      console.log("[DEBUG] Bogus User Input 'OK' Added to Conversation History.");

      currentIndex++;
      const secondPrompt = PROMPT_LIST[currentIndex]?.prompt_text || "No further prompts.";
      console.log("[DEBUG] Next Prompt for Second Call:", secondPrompt);

      conversationHistory = [
        { role: "system", content: secondPrompt },
        ...conversationHistory.filter((entry) => entry.role !== "system"),
      ];
      console.log("[DEBUG] Updated Conversation History for Second Call:\n", JSON.stringify(conversationHistory, null, 2));

      // Apply buffer management here before the second payload
      conversationHistory = manageBuffer(conversationHistory);

      const payload2 = {
        model: "llama3-8b-8192",
        messages: conversationHistory,
        max_tokens: 512,
        temperature: 0.7,
        top_p: 1,
        n: 1,
        stream: false,
      };

      console.log("[DEBUG] Token Count for Second Call Payload:", payload2.messages.length);
      const assistantContent2 = await fetchApiResponseWithRetry(payload2, 2, 500);

      if (!assistantContent2) {
        console.warn("[WARN] Second API call failed. Falling back to the first response only.");
        return new Response(assistantContent1, { status: 200 });
      }

      conversationHistory.push({ role: "assistant", content: assistantContent2 });
      console.log("[DEBUG] Second API Response Added to Conversation History.");

      // If the previous prompt is marked as important_memory, add an Important Memory line
if (PROMPT_LIST[currentIndex - 1]?.important_memory) {
  const systemIndex = conversationHistory.findIndex((msg) => msg.role === "system");
  const insertIndex = systemIndex + 1;

  conversationHistory.splice(insertIndex, 0, {
    role: "assistant",
    content: `Important_memory: ${assistantContent2}`
  });

  console.log("[DEBUG] Important Memory Added to Conversation History at index:", insertIndex);
}


      // Apply buffer management here after adding second assistant response
      conversationHistory = manageBuffer(conversationHistory);

      const combined = `${assistantContent1}\n\n${assistantContent2}`;
      console.log("[DEBUG] Final Combined Response Sent:\n", combined);
      return new Response(combined, { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    return new Response(assistantContent1, { status: 200 });
  } catch (error: any) {
    console.error("[ERROR] in POST handler:\n", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

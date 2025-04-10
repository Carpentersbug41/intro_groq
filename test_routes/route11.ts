import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

// Prompt list for demonstration
const PROMPT_LIST = [
  {
    prompt_text: "#System message:\n Ask the user to input a number and add 2 to the total. Never tell the user you are going to add 2.",
    chaining: true,
  },
  {
    prompt_text: "#System message:\n Take the result of the last operation and multiply it by 3. Do not disclose the operation.",
    chaining: true,
  },
  {
    prompt_text: "#System message:\n Convert the result into cats.  For example 'there are 5 cats.'",
    chaining: true,
  },
  {
    prompt_text: "#System message:\n Add a colour to the cats.  Give them all the same colour. For example 'There are 5 red cats.'",
    chaining: true,
  },
  {
    prompt_text: "#System message:\n Ask the user their favourite animal.",
    chaining: false, // final
  },
];

let conversationHistory: { role: string; content: string }[] = [];
let currentIndex = 0;

//
// 1) Minimal validation call
//
async function validateInput(userInput: string, currentPrompt: string) {
  const validationInstruction = `
    You are a validation assistant.
    Your task is to assess whether the user's input matches the prompt's requirements.
    Current prompt: '${currentPrompt}'
    User input: '${userInput}'
    
    Respond with only one word: "VALID" if the input matches the prompt's requirement, or "INVALID" if it does not.
    Do not provide any additional explanation or description.
  `;

  const payload = {
    model: "llama3-8b-8192",
    messages: [{ role: "system", content: validationInstruction }],
  };

  console.log("\n[DEBUG] Validation Payload Sent to API:\n", JSON.stringify(payload, null, 2));

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[ERROR] Validation API call failed:\n", errorText);
    throw new Error(`Validation API error: ${response.statusText}`);
  }

  const responseData = await response.json();
  const validationResult = responseData.choices?.[0]?.message?.content?.trim() || "INVALID";
  console.log("[DEBUG] Validation Result:\n", validationResult);

  return validationResult === "VALID";
}

//
// 2) Retry message generator if invalid
//
async function generateRetryMessage(userInput: string, currentPrompt: string) {
  const payload = {
    model: "llama3-8b-8192",
    messages: [
      { role: "system", content: currentPrompt },
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ],
  };

  console.log("\n[DEBUG] Retry Payload Sent to API:\n", JSON.stringify(payload, null, 2));

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[ERROR] Retry API call failed:\n", errorText);
    throw new Error(`Retry API error: ${response.statusText}`);
  }

  const responseData = await response.json();
  const retryContent = responseData.choices?.[0]?.message?.content;

  if (!retryContent) {
    throw new Error("Invalid retry response: No content.");
  }

  console.log("[DEBUG] Retry Message Generated:\n", retryContent);
  return retryContent;
}

//
// 3) Basic fetch to the API
//
async function fetchApiResponse(payload: any): Promise<string | null> {
  console.log("\n[DEBUG] Sending Payload to API:\n", JSON.stringify(payload, null, 2));
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ERROR] API call failed:\n", errorText);
      return null;
    }

    const responseData = await response.json();
    return responseData.choices?.[0]?.message?.content || null;
  } catch (error: any) {
    console.error("[ERROR] fetchApiResponse:\n", error.message);
    return null;
  }
}

//
// 4) chainIfNeeded logic (MODIFIED FOR PROPER CHAINING)
//
async function chainIfNeeded(assistantContent: string): Promise<string | null> {
  let chainResponse = assistantContent;

  while (true) {
    // A) Check if we have more prompts or if the next prompt is chaining
    if (currentIndex >= PROMPT_LIST.length) {
      console.log("[CHAIN DEBUG] No more prompts to chain.");
      return chainResponse;
    }
    if (!PROMPT_LIST[currentIndex]?.chaining) {
      console.log("[CHAIN DEBUG] Next prompt is not chaining. Stopping chain.");
      return chainResponse;
    }

    console.log("[CHAIN DEBUG] Preparing to chain. Assistant output will become user input.");
    const systemPrompt = PROMPT_LIST[currentIndex]?.prompt_text || "No further prompts.";

    // B) Temporarily store the assistant’s last text as a user message
    conversationHistory.push({ role: "user", content: chainResponse });

    // C) Filter out duplicates (assistant => user with same content)
    conversationHistory = conversationHistory.filter((entry, index, self) => {
      return !(
        entry.role === "assistant" &&
        self[index + 1]?.role === "user" &&
        self[index + 1]?.content === entry.content
      );
    });

    console.log("[CHAIN DEBUG] conversationHistory AFTER filtering duplicates:\n", JSON.stringify(conversationHistory, null, 2));

    // D) Build the next payload:
    //    For each conversation entry, if an item is "user" but has an identical "assistant" entry in the history,
    //    then label it as "assistant" in the final payload. This ensures the final payload is "good."
    const tempHistory = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.map((entry) => {
        const wasAssistantBefore = conversationHistory.some(
          (msg) => msg.role === "assistant" && msg.content === entry.content
        );
        if (entry.role === "user" && wasAssistantBefore) {
          return { role: "assistant", content: entry.content };
        }
        return entry;
      }),
    ];

    console.log("[CHAIN DEBUG] tempHistory used for chainPayload:\n", JSON.stringify(tempHistory, null, 2));

    const chainPayload = {
      model: "llama3-8b-8192",
      messages: tempHistory,
    };

    console.log("[CHAIN DEBUG] Sending chaining payload to LLM:\n", JSON.stringify(chainPayload, null, 2));

    // E) Move to the next system prompt
    currentIndex++;

    // F) Send the request
    const chainResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(chainPayload),
    });

    if (!chainResp.ok) {
      const errorText = await chainResp.text();
      console.error("[CHAIN DEBUG] Chaining call failed:\n", errorText);
      return chainResponse;
    }

    const chainData = await chainResp.json();
    const newAssistantContent = chainData.choices?.[0]?.message?.content;

    if (!newAssistantContent) {
      console.warn("[CHAIN DEBUG] No new content returned from chain.");
      return chainResponse;
    }

    console.log("[CHAIN DEBUG] newAssistantContent:", newAssistantContent);

    // G) Append as an assistant message
    conversationHistory.push({ role: "assistant", content: newAssistantContent });

    // H) Update chainResponse
    chainResponse = newAssistantContent;
  }
}

/**
 * The main POST handler
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const userMessage = body.message?.trim();

    console.log("[INFO] Received User Input:", userMessage || "[No Input Provided]");

    if (!userMessage) {
      console.log("[WARN] No User Input Received. Returning Error.");
      return new Response("No input received. Please try again.", { status: 400 });
    }

    const currentPrompt = PROMPT_LIST[currentIndex]?.prompt_text;
    if (!currentPrompt) {
      const finalMsg = "Thank you for your responses! Goodbye.";
      conversationHistory.push({ role: "assistant", content: finalMsg });
      console.log("[INFO] Conversation ended. No more prompts.");
      return new Response(finalMsg, { status: 200 });
    }

    console.log("[DEBUG] Current Prompt:", currentPrompt);
    console.log("[DEBUG] Pushing user message to history:\n", userMessage);

    // 1) Append user’s input
    conversationHistory.push({ role: "user", content: userMessage });

    // 2) Validate
    const isValid = await validateInput(userMessage, currentPrompt);
    if (!isValid) {
      const retryMsg = await generateRetryMessage(userMessage, currentPrompt);
      conversationHistory.push({ role: "assistant", content: retryMsg });
      return new Response(retryMsg, { status: 200 });
    }

    // 3) Advance prompt index
    currentIndex++;

    // 4) Build main payload for the LLM with the current prompt + conversation
    const payload = {
      model: "llama3-8b-8192",
      messages: [{ role: "system", content: currentPrompt }, ...conversationHistory],
    };

    console.log("[DEBUG] Main Payload to LLM:\n", JSON.stringify(payload, null, 2));

    // 5) Call the LLM
    const mainResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!mainResp.ok) {
      const errorText = await mainResp.text();
      console.error("[ERROR] Main API call failed:\n", errorText);
      return new Response("I'm sorry, I couldn't process that. Please try again.", { status: 200 });
    }

    const mainData = await mainResp.json();
    const assistantContent = mainData.choices?.[0]?.message?.content;
    if (!assistantContent) {
      console.warn("[WARN] No content returned from main call.");
      return new Response("No content returned. Please try again.", { status: 200 });
    }

    console.log("[DEBUG] assistantContent from main call:\n", assistantContent);

    // 6) Append the new assistant content to conversation
    conversationHistory.push({ role: "assistant", content: assistantContent });
    console.log("[DEBUG] Updated History after main call:\n", JSON.stringify(conversationHistory, null, 2));

    // 7) Check if more chaining is required
    const finalChained = await chainIfNeeded(assistantContent);
    return new Response(finalChained || assistantContent, { status: 200 });

  } catch (err: any) {
    console.error("[ERROR] POST Handler:\n", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

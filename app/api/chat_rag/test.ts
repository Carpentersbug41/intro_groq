export async function POST(req: NextRequest) {
  // Check if body.stream is set
  let body: any;
  try {
    body = await req.json();
  } catch (err) {
    return new Response("No input received. Please try again.", { status: 400 });
  }

  // If stream === true, do SSE streaming
  if (body.stream === true) {
    return handleStreamingFlow(body.message);
  } else {
    // Else, do the existing "non-streaming" logic
    return handleNonStreamingFlow(body.message);
  }
}

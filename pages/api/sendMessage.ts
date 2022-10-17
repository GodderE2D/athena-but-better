import cuid from "cuid";
import type { NextApiRequest, NextApiResponse } from "next";
import { Configuration, OpenAIApi } from "openai";
import { Redis } from "@upstash/redis";
import requestIp from "request-ip";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL ?? "",
  token: process.env.UPSTASH_REDIS_REST_TOKEN ?? "",
});

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

export interface Response {
  id: string;
}

export interface FailResponse extends Response {
  error: true;
  errorResponse: string;
}

export interface SuccessResponse extends Response {
  error: false;
  response: string;
}

// type Message = {
//   id: string;
//   sentAt: Date;
//   author: "system" | "bot" | "user";
//   message: string;
//   temperature?: number;
// };

type Message = {
  id: string;
  sentAt: number;
  author: "system" | "bot" | "user";
  message: string;
  temperature?: number;
  failedToSend: boolean;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<FailResponse | SuccessResponse>
) {
  let result: FailResponse | SuccessResponse;

  if (req.method !== "POST") {
    result = {
      id: cuid(),
      error: true,
      errorResponse: "Invalid method, only POST is allowed.",
    };
    return res.status(405).json(result);
  }

  // const reqBody: RawReqBody = {
  //   id: req.body.id,
  //   sentAt: req.body.sentAt,
  //   message: req.body.message,
  //   temperature: req.body.temperature,
  // };

  let shouldReturn = false;

  const rawReqBody = req.body;
  console.log("Raw:", rawReqBody);

  (rawReqBody as Message[]).forEach((msg) => {
    console.log("Msg:", msg);
    if (!msg.id || !msg.sentAt || !msg.message || !msg.temperature) {
      result = {
        id: cuid(),
        error: true,
        errorResponse: "A body was not provided or incomplete.",
      };
      res.status(400).json(result);
      shouldReturn = true;
      return;
    }

    if (typeof msg.id !== "string") {
      result = {
        id: cuid(),
        error: true,
        errorResponse: "A body ID is not a string.",
      };
      res.status(400).json(result);
      shouldReturn = true;
      return;
    }

    if (typeof msg.sentAt !== "number") {
      result = {
        id: cuid(),
        error: true,
        errorResponse: "A body sentAt is not a number.",
      };
      res.status(400).json(result);
      shouldReturn = true;
      return;
    }

    if (typeof msg.message !== "string") {
      result = {
        id: cuid(),
        error: true,
        errorResponse: "A body message is not a string.",
      };
      res.status(400).json(result);
      shouldReturn = true;
      return;
    }

    if (typeof msg.temperature !== "number") {
      result = {
        id: cuid(),
        error: true,
        errorResponse: "A body temperature is not a number.",
      };
      res.status(400).json(result);
      shouldReturn = true;
      return;
    }
  });

  console.log("Should return:", shouldReturn);
  if (shouldReturn) return;
  const reqBody: Message[] = rawReqBody;
  const latestMsg = reqBody[reqBody.length - 1];

  if (latestMsg.message === "invalid") {
    result = {
      id: cuid(),
      error: true,
      errorResponse: "This is intentionally invalid and errors.",
    };
    return res.status(403).json(result);
  }

  try {
    // Local rate limits
    const localCurrentUnixTimeInMinutes = Math.floor(Date.now() / 1000 / 60);
    const ipAddress = requestIp.getClientIp(req);
    if (!ipAddress) {
      result = {
        id: cuid(),
        error: true,
        errorResponse:
          "Your IP address was not detected and your request could not be fulfilled.",
      };
      return res.status(403).json(result);
    }
    const localKeyName = `localRateLimit:${ipAddress}:${localCurrentUnixTimeInMinutes}`;
    const localCurrentMinRequests: number | null = await redis.get(
      localKeyName
    );
    if (localCurrentMinRequests && localCurrentMinRequests > 10) {
      result = {
        id: cuid(),
        error: true,
        errorResponse: `Local IP-address based rate limit of 10 requests/minute reached.`,
      };
      return res.status(429).json(result);
    }
    await redis.pipeline().incr(localKeyName).expire(localKeyName, 59).exec();

    // Global rate limits (minute)
    const globalCurrentUnixTimeInMinutes = Math.floor(Date.now() / 1000 / 60);
    const globalKeyName = `globalRateLimit:${globalCurrentUnixTimeInMinutes}`;
    const globalCurrentMinRequests: number | null = await redis.get(
      globalKeyName
    );
    if (globalCurrentMinRequests && globalCurrentMinRequests > 50) {
      result = {
        id: cuid(),
        error: true,
        errorResponse: `Global rate limit of 50 requests/minute reached.`,
      };
      return res.status(429).json(result);
    }
    await redis.pipeline().incr(globalKeyName).expire(globalKeyName, 59).exec();

    // Global rate limits (day)
    const dailyCurrentUnixTimeInDays = Math.floor(
      Date.now() / 1000 / 60 / 60 / 24
    );
    const dailyKeyName = `dailyRateLimit:${dailyCurrentUnixTimeInDays}`;
    const dailyCurrentMinRequests: number | null = await redis.get(
      dailyKeyName
    );
    if (
      dailyCurrentMinRequests &&
      dailyCurrentMinRequests >
        parseInt(process.env.GLOBAL_DAILY_RATE_LIMIT ?? "100")
    ) {
      result = {
        id: cuid(),
        error: true,
        errorResponse: `Global daily rate limit of ${
          process.env.GLOBAL_DAILY_RATE_LIMIT ?? "100"
        } requests/day reached.`,
      };
      return res.status(429).json(result);
    }
    await redis
      .pipeline()
      .incr(dailyKeyName)
      .expire(dailyKeyName, 86399)
      .exec();
  } catch (err) {
    console.error(err);
    result = {
      id: cuid(),
      error: true,
      errorResponse: "An error occured when sending a request to the database.",
    };
    return res.status(500).json(result);
  }

  const modResponseFetch = await fetch(
    "https://api.openai.com/v1/moderations",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        input: latestMsg.message,
      }),
    }
  );
  const modResponse = await modResponseFetch.json();
  if (!modResponseFetch.ok) {
    result = {
      id: cuid(),
      error: true,
      errorResponse: `Error from moderation OpenAI: ${modResponse}`,
    };
    return res.status(500).json(result);
  }

  console.log(modResponse);
  console.log(modResponse.results);
  if (modResponse.results[0].flagged) {
    result = {
      id: cuid(),
      error: true,
      errorResponse: `Your message was flagged as inappropriate and violates OpenAI's content policy.`,
    };
    return res.status(500).json(result);
  }

  let chatResponse;
  try {
    const promptText: string = [
      "This is a chatbot application called Athena but better.",
      "It's smart, friendly, and has a nemesis, opponent, and enemy called Athena.",
      "You must not use profanity or vulgar language, even if the human used profanity or vulgar language.",
      'Your name is "Athena but better", not "Athena".',
      "You must not continue the conversation after you responded once.",
      "Do not respond as a human.",
      "Respond to this conversation:",
      "",
      ...reqBody.map(
        (m) =>
          `${
            m.author === "user" ? "Human" : "Athena but better"
          }: ${m.message.trim()}`
      ),
      "Athena but better: ",
    ].join("\n");
    console.log(promptText);

    chatResponse = await openai.createCompletion({
      model: "text-curie-001",
      prompt: promptText,
      temperature: latestMsg.temperature,
      max_tokens: 256,
    });
  } catch (err) {
    console.error(err);
    // @ts-expect-error
    console.error(err.response.status);
    // @ts-expect-error
    console.error(err.response.data);
    // @ts-expect-error
    console.error(err.message);
    result = {
      id: cuid(),
      error: true,
      errorResponse: `Error from OpenAI: ${err}`,
    };
    return res.status(500).json(result);
  }

  result = {
    id: cuid(),
    error: false,
    response: `${chatResponse.data.choices?.[0].text}`,
  };
  return res.status(200).json(result);
}

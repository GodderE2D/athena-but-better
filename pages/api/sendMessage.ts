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

type RawReqBody = {
  id?: unknown;
  sentAt?: unknown;
  message?: unknown;
  temperature?: unknown;
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

  const reqBody: RawReqBody = {
    id: req.body.id,
    sentAt: req.body.sentAt,
    message: req.body.message,
    temperature: req.body.temperature,
  };

  if (
    !reqBody.id ||
    !reqBody.sentAt ||
    !reqBody.message ||
    !reqBody.temperature
  ) {
    result = {
      id: cuid(),
      error: true,
      errorResponse: "The body was not provided or incomplete.",
    };
    return res.status(400).json(result);
  }

  if (typeof reqBody.id !== "string") {
    result = {
      id: cuid(),
      error: true,
      errorResponse: "The body ID is not a string.",
    };
    return res.status(400).json(result);
  }

  if (typeof reqBody.sentAt !== "number") {
    result = {
      id: cuid(),
      error: true,
      errorResponse: "The body sentAt is not a number.",
    };
    return res.status(400).json(result);
  }

  if (typeof reqBody.message !== "string") {
    result = {
      id: cuid(),
      error: true,
      errorResponse: "The body message is not a string.",
    };
    return res.status(400).json(result);
  }

  if (typeof reqBody.temperature !== "number") {
    result = {
      id: cuid(),
      error: true,
      errorResponse: "The body temperature is not a number.",
    };
    return res.status(400).json(result);
  }

  if (reqBody.message === "invalid") {
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
    if (dailyCurrentMinRequests && dailyCurrentMinRequests > 50) {
      result = {
        id: cuid(),
        error: true,
        errorResponse: `Global daily rate limit of 50 requests/day reached.`,
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

  let chatResponse;
  try {
    chatResponse = await openai.createCompletion({
      model: "text-curie-001",
      prompt: `This is a chatbot application called Athena but better. It's smart, friendly, and has a nemesis, opponent, and enemy called Athena. Your name is "Athena but better", not "Athena". You must not continue the conversation after you responded once. Do not fill in responses that are meant for humans. Respond to this conversation:\n\nHuman: ${reqBody.message}\nAthena but better:`,
      temperature: reqBody.temperature,
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

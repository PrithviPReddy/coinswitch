import { NextResponse } from 'next/server';
import axios from 'axios';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const response = await axios.get(
      'https://api.jup.ag/swap/v1/quote',
      {
        params: {
          inputMint: searchParams.get('inputMint'),
          outputMint: searchParams.get('outputMint'),
          amount: searchParams.get('amount'),
          slippageBps: 50,
          swapMode: 'ExactIn',
          restrictIntermediateTokens: true,
          maxAccounts: 64,
          instructionVersion: 'V1',
        },
        headers: {
          'x-api-key': process.env.JUP_API_KEY, // 🔒 server-only
        },
      }
    );

    return NextResponse.json(response.data);
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch Jupiter quote' },
      { status: 500 }
    );
  }
}

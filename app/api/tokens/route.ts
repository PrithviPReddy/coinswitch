import { NextRequest } from "next/server";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token"
import { connection, SUPPORTED_TOKENS } from "@/app/lib/constants";
import { PublicKey } from "@solana/web3.js";

export async function GET(req:NextRequest, res:NextRequest){
    const { searchParams } = new URL(req.url)
    const address = searchParams.get('address')!()
    const owner = new PublicKey(address)
    const balances = await Promise.all(
        SUPPORTED_TOKENS.map(token => {
            const mint = new PublicKey(token.mint);
            return getAssociatedTokenAddress(mint, owner);
        })
    );
    //ATA  = Associated token account 
    //PDA  = PRogram derived address



}

async function getAccountBalance(token : { 
    name: string,
    mint : string
}, address : string){

    const ata = await getAssociatedTokenAddress(new PublicKey(token.mint),new PublicKey(address))
    const account = await getAccount(connection,ata)


}
import { getServerSession } from "next-auth"
import { ProfileCard } from "../components/ProfileCard"
import { authConfig } from "../lib/auth"
import db from "../db"


async function getUserWallet(){
    const session  = await getServerSession(authConfig)
    
    const userWallet= await db.solWallet.findFirst({
        where :{
            userId : session?.user.uid
        },
        select : { 
            publicKey : true
        }
    })

    if (!userWallet){
        return {
            error:"No solana Wallet associated"
        }
    }

    return {error:null ,userWallet}
}

export default async function dashboard(){
    const userWallet = await getUserWallet()
    const publicKey = userWallet.userWallet?.publicKey
    
    if( userWallet.error || !publicKey ){
        return<div>
            No User Wallet found
        </div>
    }

    return <ProfileCard publicKey= {userWallet.userWallet?.publicKey}/>

}
import { ProfileCard } from "../components/ProfileCard"


async function getUserWallet(){
    
}

export default function dashboard(){
    const userWallet = ----------
    
    if(!userWallet.userWallet?.publicKey || userWallet.error){
        return<div>
            No User Wallet found
        </div>
    }

    return 
        <ProfileCard publicKey= { userWallet.useWallet?.publicKey}/>

}
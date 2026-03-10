import { NextResponse } from "next/server"

const projectId =
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID

export async function POST(req:Request){

 const { postIds,userId } = await req.json()

 if(!postIds || postIds.length !== 9){
  return NextResponse.json(
   {error:"9 posts required"},
   {status:400}
  )
 }

 const shareId =
 crypto.randomUUID().replace(/-/g,"").slice(0,8)

 const imageUrls = await Promise.all(

  postIds.map(async(id:string)=>{

   const url =
   `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/posts/${id}`

   const doc = await fetch(url).then(r=>r.json())

   return doc.fields.imageUrl.stringValue
  })

 )

 const saveUrl =
 `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/nineShares/${shareId}`

 await fetch(saveUrl,{
  method:"PATCH",
  headers:{
   "Content-Type":"application/json"
  },
  body:JSON.stringify({

   fields:{

    postIds:{
     arrayValue:{
      values:postIds.map((id:string)=>({
       stringValue:id
      }))
     }
    },

    imageUrls:{
     arrayValue:{
      values:imageUrls.map((u:string)=>({
       stringValue:u
      }))
     }
    },

    userId:{
     stringValue:userId || "unknown"
    },

    createdAt:{
     timestampValue:new Date().toISOString()
    }

   }

  })
 })

 return NextResponse.json({shareId})
}
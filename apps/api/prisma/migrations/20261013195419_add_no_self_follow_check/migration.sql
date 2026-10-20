-- AlterTable
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_no_self_follow_check" CHECK ("followerId" <> "followedId");
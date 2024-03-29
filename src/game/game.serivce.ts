import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Connection as MongoConnection, Model, ObjectId, Types } from "mongoose";
import { User, UserDocument } from "src/user/user.schema";
import { UserService } from "src/user/user.service";
import { CreateGameDto } from "./dto/createGame.dto";
import { GameGateway } from "./game.gateway";
import { Game, GameDocument } from "./game.schema";
import { GameIdDto } from "./dto/gameId.dto";
import { JoinGameDto } from "./dto/joinGame.dto";
import assert from "assert";

const GAME_FEE = 4

const LAST_GAMES_TO_SHOW = 30

@Injectable()
export class GameService {
    constructor(@InjectConnection() private readonly dbConnection: MongoConnection, @InjectModel(Game.name) private gameModel: Model<GameDocument>, private userService: UserService, private gameGateway: GameGateway) { this.calculateDailyFees() }

    async calculateDailyFees() {
        const games = await this.gameModel.find({ status: 'ended' })
        let totalBets = 0
        games.forEach(game => {
            totalBets += game.amount * 2
        })
    }

    async create(user: UserDocument, createGameDto: CreateGameDto) {
        const payAmount = createGameDto.amount * (1 + GAME_FEE / 100)

        if (user.balance < payAmount) throw new HttpException(`Balance needs to be higher than the game bet + fee (${payAmount / LAMPORTS_PER_SOL} SOL)`, HttpStatus.FORBIDDEN)
        const userActiveCount = await this.userActiveCount(user._id)

        if (userActiveCount >= 5) throw new HttpException("You can't have more than 5 active games", HttpStatus.FORBIDDEN)

        const session = await this.dbConnection.startSession()
        session.startTransaction()
        user.$session(session)

        try {
            const newGame = new this.gameModel(createGameDto)
            newGame.creator = user
            newGame.creatorMove = createGameDto.creatorMove

            await this.userService.changeBalance(user, -payAmount)
            await newGame.save()

            await session.commitTransaction()
            this.gameGateway.newGameNotify(newGame)
        } catch (e) {
            await session.abortTransaction()
            throw new HttpException(`Failed to create a game`, HttpStatus.FORBIDDEN)
        } finally {
            session.endSession()
        }
    }

    async join(joinGameDto: JoinGameDto, user: UserDocument) {
        const game = await this.findById(joinGameDto.gameId, { selectCreatorMove: true })

        if (!game) throw new HttpException('Game does not exists', HttpStatus.FORBIDDEN)
        if (game.status !== 'active') throw new HttpException('You can join only active games', HttpStatus.FORBIDDEN)

        const payAmount = game.amount * (1 + GAME_FEE / 100)
        if (user.balance < payAmount) throw new HttpException(`Balance needs to be higher than the game bet + fee (${payAmount / LAMPORTS_PER_SOL} SOL)`, HttpStatus.FORBIDDEN)
        if (user._id.equals(game.creator._id)) throw new HttpException('You can not join your own game', HttpStatus.FORBIDDEN)

        const session = await this.dbConnection.startSession()
        session.startTransaction()
        game.$session(session)
        game.creator.$session(session)
        user.$session(session)

        try {
            game.opponent = user
            game.opponentMove = joinGameDto.move
            game.endedAt = Date.now()
            game.status = 'ended'

            await this.userService.changeBalance(user, -payAmount)
            await this.pickWinner(game)
            await session.commitTransaction()

            this.gameGateway.gameUpdateNotify(game)
        } catch (e) {
            await session.abortTransaction()
            throw new HttpException('Failed to join a game', HttpStatus.FORBIDDEN)
        } finally {
            session.endSession()
        }
    }

    async pickWinner(game: GameDocument) {
        const opponent = game.opponent
        const creator = game.creator

        if (game.creatorMove === game.opponentMove) {
            await this.userService.changeBalance(creator, game.amount * (1 + GAME_FEE / 100), { disableNotification: true })
            await this.userService.changeBalance(opponent, game.amount * (1 + GAME_FEE / 100), { disableNotification: true })
        } else {
            const moves = [game.creatorMove, game.opponentMove].sort()
            let winningChoice;
            if (moves[0] === 0 && moves[1] === 2) {
                winningChoice = 0
            } else {
                winningChoice = moves[1]
            }

            const winner = game.creatorMove === winningChoice ? creator : opponent
            game.winner = winner

            await this.userService.changeBalance(winner, game.amount * 2, { disableNotification: true })
        }

        await game.save()
    }

    async cancel(gameIdDto: GameIdDto, user: UserDocument) {
        const game = await this.findById(gameIdDto.gameId)
        if (!game) throw new HttpException('Game does not exists', HttpStatus.FORBIDDEN)

        if (!user._id.equals(game.creator._id)) throw new HttpException('You can not cancel another person`s game', HttpStatus.FORBIDDEN)
        if (game.status !== 'active') throw new HttpException('You can cancel only active game', HttpStatus.FORBIDDEN)

        const session = await this.dbConnection.startSession()
        session.startTransaction()
        game.$session(session)
        user.$session(session)

        try {
            game.status = 'cancelled'
            await game.save()
            await this.userService.changeBalance(user, game.amount * (1 + GAME_FEE / 100))

            await session.commitTransaction()
            this.gameGateway.gameUpdateNotify(game)
        } catch (e) {
            await session.abortTransaction()
            throw new HttpException('Failed to cancel a game', HttpStatus.FORBIDDEN)
        } finally {
            session.endSession()
        }

    }

    async findById(userId: Types.ObjectId, options?: { selectCreatorMove: boolean }): Promise<GameDocument | null> {
        if (options?.selectCreatorMove) {
            return this.gameModel.findById(userId).populate('creator opponent winner').select('+creatorMove').exec()
        }
        return this.gameModel.findById(userId).populate('creator opponent winner').exec()
    }

    async findByUserId(userId: Types.ObjectId) {
        const games = await this.gameModel.find({ $or: [{ creator: userId }, { opponent: userId }], status: 'ended' })
            .populate('creator opponent winner')
            .select('+creatorMove')
            .sort({ updatedAt: -1 })

        return games
    }

    async findByUserPublicKey(publicKey: string) {
        const user = await this.userService.findByPublicKey(publicKey)

        if (!user) return null

        return this.findByUserId(user._id)
    }

    async getActive(): Promise<GameDocument[]> {
        return this.gameModel.find({ status: 'active' }).populate('creator opponent')
    }

    async getLastEnded(): Promise<GameDocument[]> {
        return this.gameModel.find({ status: 'ended' }).populate('creator opponent winner').select('+creatorMove').sort({ updatedAt: -1 }).limit(LAST_GAMES_TO_SHOW)
    }

    async userActiveCount(userId: ObjectId): Promise<number> {
        return this.gameModel.count({ creator: userId, status: 'active' })
    }
}
import {
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayInit,
} from '@nestjs/websockets';

import { Socket, Server } from 'socket.io';
import { sessionMiddleware } from 'src/main';

@WebSocketGateway({ namespace: 'user', cors: true })
export class UserGateway implements OnGatewayConnection {
    @WebSocketServer() server: Server;

    handleConnection(client: Socket, ...args: any[]) {
    }

    @SubscribeMessage('subscribeToProfile')
    handleSubscribeToProfile(client: Socket, _id: string) {
        client.join(_id)
    }

    balanceChangeNotify(_id: Object, balance: number, fromDeposit = false) {
        this.server.to(_id.toString()).emit('balanceChange', balance, fromDeposit)
    }
}
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes } from 'mongoose';
import { UserDocument } from 'src/user/user.schema';

export type TransactionDocument = Transaction & Document;

@Schema()
export class Transaction {
    @Prop({ type: SchemaTypes.ObjectId, ref: 'User' })
    owner: UserDocument

    @Prop()
    signature: string;

    @Prop({ enum: ['deposit', 'withdraw'] })
    type: string

    @Prop({ enum: ['pending', 'confirmed'] })
    status: string
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);

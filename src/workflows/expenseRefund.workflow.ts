import { ExpenseRefundStatus } from '../shared';

export type ExpenseRefundAction =
  | 'ACCOUNTANT_APPROVE'
  | 'ACCOUNTANT_REJECT'
  | 'MD_APPROVE'
  | 'MD_REJECT'
  | 'MARK_REFUNDED';

export class ExpenseRefundWorkflow {
  static validateTransition(currentStatus: string, action: ExpenseRefundAction): void {
    const validTransitions: Record<string, ExpenseRefundAction[]> = {
      [ExpenseRefundStatus.PENDING]: ['ACCOUNTANT_APPROVE', 'ACCOUNTANT_REJECT'],
      [ExpenseRefundStatus.ACCOUNTANT_APPROVED]: ['MD_APPROVE', 'MD_REJECT'],
      [ExpenseRefundStatus.MD_APPROVED]: ['MARK_REFUNDED'],
    };

    const allowedActions = validTransitions[currentStatus] || [];

    if (!allowedActions.includes(action)) {
      throw { status: 409, message: `Invalid workflow transition: Cannot perform ${action} from state ${currentStatus}` };
    }
  }
}
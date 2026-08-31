import { prisma } from '../lib/prisma';
import { PrismaClient, Installment } from '@prisma/client';
import { TokenPayload } from '../utils/jwt';
import { BookingPolicy } from '../policies/booking.policy';


const p = prisma;

export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'AppError';
  }
}

export class InstallmentService {
  /**
   * Create a new installment schedule for a booking.
   */
  static async createInstallment(
    user: TokenPayload,
    bookingId: number,
    dto: { installment_number: number; expected_amount: number; due_date: string; remarks?: string }
  ) {
    // 1. Verify booking exists and user has access
    const booking = await p.booking.findFirst({
      where: { id: bookingId, company_id: user.companyId },
    });

    if (!booking) {
      throw new AppError(404, 'Booking not found');
    }

    if (!BookingPolicy.canView(user, booking)) {
      throw new AppError(403, 'You do not have access to this booking');
    }

    // 2. Validate basic rules
    if (dto.expected_amount <= 0) {
      throw new AppError(400, 'Installment amount must be greater than zero');
    }

    try {
      // 3. Create installment
      const installment = await p.installment.create({
        data: {
          booking_id: booking.id,
          installment_number: dto.installment_number,
          expected_amount: dto.expected_amount,
          due_date: new Date(dto.due_date),
          remarks: dto.remarks,
          recorded_by_id: user.employeeId,
        },
      });

      // Audit log
      await p.auditEvent.create({
        data: {
          actor_id: user.employeeId,
          action: 'INSTALLMENT_CREATED',
          entity_type: 'Installment',
          entity_id: installment.id,
          new_value: JSON.stringify({ amount: dto.expected_amount, due: dto.due_date }),
        },
      });

      return installment;
    } catch (error: any) {
      // Catch duplicate constraint unique(booking_id, installment_number)
      if (error.code === 'P2002') {
        throw new AppError(409, 'An installment with this number already exists for this booking');
      }
      throw error;
    }
  }

  /**
   * Retrieve installments for a booking with lazy OVERDUE evaluation.
   */
  static async getInstallments(user: TokenPayload, bookingId: number) {
    const booking = await p.booking.findFirst({
      where: { id: bookingId, company_id: user.companyId },
    });

    if (!booking) {
      throw new AppError(404, 'Booking not found');
    }

    if (!BookingPolicy.canView(user, booking)) {
      throw new AppError(403, 'You do not have access to this booking');
    }

    const installments = await p.installment.findMany({
      where: { booking_id: booking.id },
      orderBy: { installment_number: 'asc' },
      include: {
        recorded_by: { select: { id: true, full_name: true } },
      },
    });

    const now = new Date();

    // Lazy OVERDUE mapping
    return installments.map((inst: any) => {
      let mappedStatus = inst.status;
      
      if (inst.status === 'PENDING' && new Date(inst.due_date) < now) {
        mappedStatus = 'OVERDUE';
      }

      return {
        ...inst,
        status: mappedStatus,
      };
    });
  }
}
